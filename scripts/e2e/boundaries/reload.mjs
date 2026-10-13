import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"

// This module runs only in the browser attached without focus overrides.
export async function runReloadBoundaryCases(harness) {
  const { check, page, context, cdp, prepareHost, until, publicMessage, reloadExtension, outputPath, errors, contentWorld, inContentWorld, extensionId, nodeGesture, heldMarkers, heldResponses, releaseHeld, setContentStoragePlan } = harness
  for (const scenario of [
    { name: "visible-pending-reload-recovery", hidden: false, frozen: false },
    { name: "hidden-pending-reload-recovery", hidden: true, frozen: false },
    { name: "hidden-frozen-page-reload-recovery", hidden: true, frozen: true },
  ]) {
    await check(scenario.name, async () => {
      const scripts = new Map()
      const onScript = script => scripts.set(script.scriptId, script)
      cdp.on("Debugger.scriptParsed", onScript)
      await cdp.send("Debugger.enable")
      await prepareHost(scenario.name, "<p id=\"p1\">An open article must recover cleanly when its extension updates during an unfinished translation request.</p>")
      const oldWorld = await contentWorld()
      const script = [...scripts.values()].find(item => item.executionContextId === oldWorld && item.url.endsWith("/content-scripts/host.js"))
      assert.ok(script, "capture the actual executing host script before reloading")
      const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId })
      await writeFile(path.join(outputPath, `${scenario.name}-executing-host.json`), JSON.stringify({ scriptId: script.scriptId, executionContextId: oldWorld, url: script.url, sha256: createHash("sha256").update(scriptSource).digest("hex") }, null, 2))
      cdp.off("Debugger.scriptParsed", onScript)
      await cdp.send("Debugger.disable")
      const pendingTitle = `Audit ${scenario.name} Article`
      heldMarkers.set(pendingTitle, "translation")
      await page.keyboard.press("Alt+KeyE")
      await until(() => heldResponses.some(response => response.entry.input.includes(pendingTitle)), "title reaches the held native provider request before reload")
      assert.equal(await inContentWorld(`globalThis.__E2E_CHROME_BOUNDARY__.messages.find(message => message.type === 'enqueueTranslateRequest' && message.text === ${JSON.stringify(pendingTitle)})?.settled`), false, "the title reply must still be pending before reload")
      let foreground
      if (scenario.hidden) {
        foreground = await context.newPage()
        await foreground.goto("about:blank")
        await foreground.bringToFront()
      }
      const visibility = await page.evaluate(() => document.visibilityState)
      assert.equal(visibility, scenario.hidden ? "hidden" : "visible", "the actual document visibility must match this reload scenario")
      const errorsBefore = errors.length
      if (scenario.frozen)
        await cdp.send("Page.setWebLifecycleState", { state: "frozen" })
      await reloadExtension()
      await (foreground ?? page).waitForTimeout(1300)
      if (scenario.frozen)
        await cdp.send("Page.setWebLifecycleState", { state: "active" })
      await page.bringToFront()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "invalidated suspended content cleaned on resume")
      const messages = await cdp.send("Runtime.evaluate", { contextId: oldWorld, expression: "JSON.stringify(globalThis.__E2E_CHROME_BOUNDARY__.messages)", returnByValue: true })
      await writeFile(path.join(outputPath, `${scenario.name}-messages.json`), messages.result.value)
      const titleReply = JSON.parse(messages.result.value).find(message => message.type === "enqueueTranslateRequest" && message.text === pendingTitle)
      assert.equal(titleReply.settled, true)
      assert.match(titleReply.error, /message channel closed/)
      assert.equal(titleReply.runtimeIdAtReply, extensionId, "the closed reply must arrive before Chrome clears the old runtime id")
      assert.equal(titleReply.visibilityAtReply, visibility, "the closed reply must arrive with the tested native visibility")
      releaseHeld(pendingTitle)
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "old translations must be removed when a suspended page resumes")
      await page.keyboard.press("Alt+KeyE")
      await page.locator("#p1").hover()
      await page.keyboard.press("Control")
      await page.waitForTimeout(200)
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "old gestures must stay inactive")
      assert.deepEqual(errors.slice(errorsBefore), [], "resuming an invalidated page must not reject storage promises")
      await page.screenshot({ path: path.join(outputPath, `${scenario.name}-resumed.png`) })
      await page.reload()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh content script after suspended reload")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === true, "fresh translation accepted")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() > 0, "fresh page translates after recovery")
      await writeFile(path.join(outputPath, `${scenario.name}.json`), JSON.stringify({ visibilityBeforeReload: visibility, frozenDuringExtensionReload: scenario.frozen, resumed: true, staleGesturesIgnored: true, freshPageTranslated: true }, null, 2))
      await foreground?.close()
    })
  }

  await check("live-channel-failure-stays-visible-and-recovers", async () => {
    await prepareHost("live-channel", "<p id=\"p1\">A live extension must still report a real closed message channel and permit translation after the next request succeeds.</p>")
    const failureText = "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"
    await inContentWorld(`(() => {
      const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime);
      globalThis.__E2E_LIVE_CHANNEL_FAILURE__ = { forwarded: false };
      globalThis.chrome.runtime.sendMessage = (...args) => {
        const request = args.find(value => value && typeof value === 'object' && value.type);
        if (request?.type === 'enqueueTranslateRequest' && request.data.text === 'Audit live-channel Article') {
          globalThis.chrome.runtime.sendMessage = send;
          return send(...args).then(() => {
            globalThis.__E2E_LIVE_CHANNEL_FAILURE__.forwarded = true;
            throw new Error(${JSON.stringify(failureText)});
          });
        }
        return send(...args);
      };
    })()`)
    await page.keyboard.press("Alt+KeyE")
    const manager = await context.newPage()
    await manager.goto(`chrome://extensions/?errors=${extensionId}`)
    let recorded
    await until(async () => {
      recorded = await manager.evaluate(async id => (await globalThis.chrome.developerPrivate.getExtensionInfo(id)).runtimeErrors, extensionId)
      return recorded.length > 0
    }, "genuine live channel error recorded")
    assert.equal(recorded.length, 1, "only the injected genuine title failure is expected")
    assert.equal(recorded[0].message, `Failed to translate document title: Error: ${failureText}`)
    assert.equal(await inContentWorld("globalThis.__E2E_LIVE_CHANNEL_FAILURE__.forwarded"), true, "the native request must be forwarded before response fault injection")
    assert.equal(await inContentWorld("globalThis.chrome.runtime.id"), extensionId, "the failure must happen while the extension remains live")
    await writeFile(path.join(outputPath, "genuine-channel-error.json"), JSON.stringify(recorded, null, 2))
    // This disposable-profile entry is asserted and saved before removing it.
    // The ordinary final empty-list assertion still catches every other error.
    await manager.evaluate(async ({ id, errorId }) => {
      await globalThis.chrome.developerPrivate.deleteExtensionErrors({ extensionId: id, errorIds: [errorId] })
    }, { id: extensionId, errorId: recorded[0].id })
    await until(async () => await manager.evaluate(async id => (await globalThis.chrome.developerPrivate.getExtensionInfo(id)).runtimeErrors.length === 0, extensionId), "only expected test error cleared")
    await manager.close()
    await page.bringToFront()
    await page.evaluate(() => {
      document.title = "Recovered live channel Article"
    })
    await until(async () => (await page.title()).startsWith("[E2E translated] Recovered live channel Article"), "the next genuine title request succeeds")
    await page.screenshot({ path: path.join(outputPath, "live-channel-recovered.png") })
    assert.deepEqual(errors, [], "a handled genuine channel failure must not become an unhandled rejection")
  })

  await check("pending-error-hydration-survives-frozen-reload", async () => {
    const text = "PENDING_HYDRATION_ERROR This provider failure mounts real error controls while theme and configuration storage replies are still pending."
    await prepareHost("pending-hydration", `<p id="p1">${text}</p>`)
    const oldWorld = await contentWorld()
    heldMarkers.set(text, "translation")
    await nodeGesture(page, "#p1")
    await until(() => heldResponses.some(response => response.entry.input.includes(text)), "manual request reaches the held HTTP provider")
    await setContentStoragePlan([
      { area: "local", method: "get", key: "theme", action: "hold", label: "pending-theme" },
      { area: "local", method: "get", key: "config", action: "hold", label: "pending-config" },
    ])
    releaseHeld(text, 401)
    await until(async () => await inContentWorld("globalThis.__E2E_NATIVE_STORAGE__.held.length === 2"), "both real hydration replies held before reload")
    const foreground = await context.newPage()
    await foreground.goto("about:blank")
    await foreground.bringToFront()
    assert.equal(await page.evaluate(() => document.visibilityState), "hidden")
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" })
    await reloadExtension()
    await foreground.waitForTimeout(1300)
    await cdp.send("Page.setWebLifecycleState", { state: "active" })
    await page.bringToFront()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "pending error UI removed after invalidation")
    const result = await cdp.send("Runtime.evaluate", {
      contextId: oldWorld,
      expression: "(() => { const state = globalThis.__E2E_NATIVE_STORAGE__; state.release('pending-theme'); state.release('pending-config'); return JSON.stringify(state.calls); })()",
      returnByValue: true,
    })
    assert.equal(result.exceptionDetails, undefined, "held native replies must remain releasable in the old document")
    await writeFile(path.join(outputPath, "pending-hydration-storage.json"), result.result.value)
    await page.waitForTimeout(100)
    assert.equal(await page.locator(".vibe-reading-react-shadow-host").count(), 0, "late hydration must not remount any old React host")
    assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0)
    assert.deepEqual(errors, [], "late storage replies must never become unhandled promises")
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh host after delayed hydration")
    await nodeGesture(page, "#p1")
    await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() > 0, "fresh gesture translates after failure and frozen reload")
    await page.screenshot({ path: path.join(outputPath, "pending-hydration-recovered.png") })
    await foreground.close()
  })
}
