import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

// The real worker fetch completes normally. Only delivery of its successful
// locale Response is held; reloading destroys the worker and closes Chrome's
// actual pending backgroundFetch channel to the old content bootstrap.
function installWorkerLocaleFetchBoundary(url) {
  const nativeFetch = globalThis.fetch
  const state = globalThis.__E2E_WORKER_LOCALE_FETCH__ = { calls: [], held: [], holdNext: true }
  const observed = async (...args) => {
    const input = args[0]
    const requestURL = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (requestURL !== url || !state.holdNext)
      return nativeFetch.apply(globalThis, args)
    state.holdNext = false
    const entry = { url: requestURL, forwardedAt: Date.now(), forwarded: true }
    state.calls.push(entry)
    try {
      const response = await nativeFetch.apply(globalThis, args)
      entry.status = response.status
      const messages = await response.clone().json()
      entry.messageCount = Object.keys(messages).length
      entry.nativeCompletedAt = Date.now()
      return await new Promise((resolve) => {
        entry.held = true
        state.held.push(() => {
          entry.deliveredAt = Date.now()
          resolve(response)
        })
      })
    }
    catch (error) {
      entry.error = error.message
      throw error
    }
  }
  globalThis.fetch = observed
  state.restore = () => {
    state.holdNext = false
    for (const release of state.held.splice(0))
      release()
    if (globalThis.fetch === observed)
      globalThis.fetch = nativeFetch
  }
}

export async function runErrorBoundaryCases(h) {
  const { check, page, context, extensionId, prepareHost, until, nodeGesture, hasTranslation, requests, setProviderStatus, setProviderFailureMessage, inContentWorld, waitForMessageResult, outputPath } = h
  for (const [suffix, message] of [
    ["canonical", "Extension context invalidated."],
    ["embedded", "Provider failed: extension context invalidated while processing the remote request"],
  ]) {
    await check(`audit-provider-message-${suffix}`, async () => {
      const neighbor = `Successful neighbor ${suffix} must remain translated when the provider rejects a different paragraph.`
      const target = `Provider wording ${suffix} must be shown as a retriable API failure without disabling this live browser extension.`
      await prepareHost(`provider-message-${suffix}`, `<p id="neighbor">${neighbor}</p><p id="target">${target}</p>`)
      await nodeGesture(page, "#neighbor")
      await until(() => hasTranslation(page, neighbor), "neighbor translated before provider error")
      await inContentWorld(`(() => {
        const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime);
        globalThis.__E2E_REPLY_ERRORS__ = [];
        globalThis.chrome.runtime.sendMessage = (...args) => send(...args).then(reply => {
          const request = args.find(value => value && typeof value === 'object' && value.type);
          if (reply?.err) globalThis.__E2E_REPLY_ERRORS__.push({type:request?.type, text:request?.data?.text, name:reply.err.name, message:reply.err.message});
          return reply;
        });
      })()`)
      setProviderFailureMessage(message)
      setProviderStatus(401)
      await nodeGesture(page, "#target")
      await until(() => requests.some(request => request.input.includes(target) && request.status === 401), "real local provider returned the selected error text")
      await waitForMessageResult("enqueueTranslateRequest", target)
      await page.waitForTimeout(100)
      const evidence = {
        providerMessage: message,
        runtimeId: await inContentWorld("globalThis.chrome.runtime.id"),
        injected: await inContentWorld("window.__READ_FROG_HOST_INJECTED__"),
        remoteErrors: await inContentWorld("globalThis.__E2E_REPLY_ERRORS__"),
        toastHosts: await page.locator("[data-vibe-reading-host-toast]").count(),
        neighborStillTranslated: await hasTranslation(page, neighbor),
        errorRoots: await page.locator("#target .vibe-reading-translation-error-container").count(),
      }
      await writeFile(path.join(outputPath, `provider-message-${suffix}.json`), JSON.stringify(evidence, null, 2))
      await page.screenshot({ path: path.join(outputPath, `provider-message-${suffix}.png`) })
      assert.equal(evidence.runtimeId, extensionId, "native context must remain live during the provider fault")
      assert.ok(evidence.remoteErrors.some(error => error.type === "enqueueTranslateRequest"
        && error.text === target && error.name === "AI_APICallError" && error.message === message),
      "the exact provider wording and remote error name must reach the real caller")
      assert.equal(evidence.toastHosts, 1, "remote wording must not unload a live content script")
      assert.equal(evidence.neighborStillTranslated, true, "a provider failure must preserve the successful neighboring translation")
      await until(async () => await page.locator("#target .vibe-reading-translation-error-container").count() === 1, "ordinary provider failure must retain Retry controls")
      setProviderStatus(200)
      setProviderFailureMessage("E2E provider temporarily unavailable")
      await page.locator("#target").getByRole("button").first().click()
      await until(() => hasTranslation(page, target), "real Retry succeeds after provider recovery")
      assert.equal(await hasTranslation(page, neighbor), true)
    })
  }

  await check("audit-rapid-reloads-pending-manual", async () => {
    const marker = "RAPID_RELOAD_AUDIT An unfinished manual translation must not retain callbacks after two consecutive extension reloads."
    await prepareHost("rapid-reloads", `<p id="target">${marker}</p>`)
    h.heldMarkers.set(marker, "translation")
    await nodeGesture(page, "#target")
    await until(() => h.heldResponses.some(response => response.entry.input.includes(marker)), "manual request held before consecutive reloads")
    const before = await h.extensionWorker()
    await h.reloadExtension()
    await until(async () => await h.extensionWorker() !== before, "first reload creates a distinct native worker")
    await (await h.extensionWorker()).evaluate(() => globalThis.chrome.runtime.id)
    await h.reloadExtension()
    await page.waitForTimeout(1400)
    assert.equal(await page.locator("[data-vibe-reading-host-toast]").count(), 0, "old host must stay disposed across both reloads")
    assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0)
    h.releaseHeld(marker, 401)
    await page.waitForTimeout(100)
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh host after consecutive reloads")
    const fresh = await page.locator("#p1").textContent()
    await nodeGesture(page, "#p1")
    await until(() => hasTranslation(page, fresh), "fresh gesture recovers after consecutive reloads")
  })

  await check("audit-disable-enable-pending-manual", async () => {
    const marker = "DISABLE_ENABLE_AUDIT A pending manual request must not reappear after disabling and enabling the same extension."
    await prepareHost("disable-enable", `<p id="target">${marker}</p>`)
    h.heldMarkers.set(marker, "translation")
    await nodeGesture(page, "#target")
    await until(() => h.heldResponses.some(response => response.entry.input.includes(marker)), "manual provider connection held before disable")
    const manager = await context.newPage()
    await manager.goto("chrome://extensions/")
    await manager.evaluate(async (id) => {
      await globalThis.chrome.management.setEnabled(id, false)
      if ((await globalThis.chrome.developerPrivate.getExtensionInfo(id)).state !== "DISABLED")
        throw new Error("Extension was not disabled")
      await globalThis.chrome.management.setEnabled(id, true)
      if ((await globalThis.chrome.developerPrivate.getExtensionInfo(id)).state !== "ENABLED")
        throw new Error("Extension was not reenabled")
    }, extensionId)
    await page.bringToFront()
    await page.waitForTimeout(1400)
    assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "disabled request must not retain obsolete UI")
    h.releaseHeld(marker, 401)
    await page.waitForTimeout(100)
    assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0, "late old response cannot mount an error after reenable")
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh enabled extension host")
    const fresh = await page.locator("#p1").textContent()
    await nodeGesture(page, "#p1")
    await until(() => hasTranslation(page, fresh), "reenabled extension successfully translates after page refresh")
    await manager.close()
  })

  await check("audit-bootstrap-resource-cancel-after-reload", async () => {
    const url = `chrome-extension://${extensionId}/_locales/en/messages.json`
    const worker = await h.extensionWorker()
    const evidence = { url, boundary: "The actual worker fetch and locale body read complete; only delivery of the native Response is held before a real extension reload closes the pending backgroundFetch channel." }
    let reloaded = false
    await worker.evaluate(installWorkerLocaleFetchBoundary, url)
    try {
      await page.goto(`${h.origin}/audit-bootstrap-resource-cancel`)
      await until(async () => await worker.evaluate(() => globalThis.__E2E_WORKER_LOCALE_FETCH__.held.length === 1), "the actual worker locale fetch completes and its native Response delivery is held", 8000)
      evidence.fetch = await worker.evaluate(() => globalThis.__E2E_WORKER_LOCALE_FETCH__.calls[0])
      assert.equal(evidence.fetch.forwarded, true, "locale loading must reach the real worker fetch")
      assert.equal(evidence.fetch.status, 200, "the held response must originate from the actual packaged locale resource")
      assert.ok(evidence.fetch.messageCount > 0 && evidence.fetch.nativeCompletedAt && evidence.fetch.held && !evidence.fetch.deliveredAt && !evidence.fetch.error)
      const world = await h.contentWorld()
      assert.equal(await page.locator("[data-vibe-reading-host-toast]").count(), 0, "locale must still be pending before host mounting")
      await h.reloadExtension()
      await until(() => !context.serviceWorkers().includes(worker), "the real reload destroys the worker holding the locale Response")
      reloaded = true
      assert.notEqual(await h.extensionWorker(), worker, "reload creates a distinct native extension worker")
      await page.waitForTimeout(1400)
      const invalidated = await h.cdp.send("Runtime.evaluate", { contextId: world, expression: "window.__READ_FROG_HOST_INJECTED__", returnByValue: true })
      assert.equal(invalidated.result.value, false, "the actual old bootstrap must be invalidated before resource failure")
      await page.waitForTimeout(100)
      assert.equal(await page.locator("[data-vibe-reading-host-toast]").count(), 0, "the old locale bootstrap must not mount a host after its real worker channel closes")
      assert.deepEqual(h.errors, [], "a cancelled resource in an invalidated bootstrap must not become an unhandled promise")
      evidence.oldBootstrapInvalidated = invalidated.result.value === false
      evidence.oldHostCount = await page.locator("[data-vibe-reading-host-toast]").count()
      evidence.errors = [...h.errors]
    }
    finally {
      if (!reloaded && context.serviceWorkers().includes(worker))
        await worker.evaluate(() => globalThis.__E2E_WORKER_LOCALE_FETCH__.restore())
    }
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh host recovers after bootstrap cancellation")
    evidence.freshHostCount = await page.locator("[data-vibe-reading-host-toast]").count()
    await writeFile(path.join(outputPath, "bootstrap-resource-cancel-after-reload.json"), JSON.stringify(evidence, null, 2))
  })

  await check("audit-pending-manager-receiver-reload", async () => {
    await prepareHost("receiver-reload", "<p id='target'>A pending popup request must not send a late error reply after its content receiver is invalidated.</p>")
    const worker = await h.extensionWorker()
    const tabId = await worker.evaluate(async url => (await globalThis.chrome.tabs.query({})).find(tab => tab.url === url).id, page.url())
    await worker.evaluate(h.installStorageBoundary)
    await worker.evaluate(key => globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "session", method: "set", key, enabled: true, action: "hold", label: "receiver-state" }), `translationState.${tabId}`)
    const popup = await context.newPage()
    // A real popup document uses Chrome's actual fixture-tab metadata because
    // this browser does not expose its action popup as a Playwright page.
    await popup.addInitScript(({ hostURL }) => {
      const query = globalThis.chrome.tabs.query.bind(globalThis.chrome.tabs)
      globalThis.chrome.tabs.query = async (args) => {
        const actual = await query(args)
        if (!args.active || !args.currentWindow)
          return actual
        const host = (await query({})).find(tab => tab.url === hostURL)
        if (!host)
          throw new Error("Actual fixture host is missing")
        return [host]
      }
    }, { hostURL: page.url() })
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await popup.bringToFront()
    await until(() => popup.getByRole("button", { name: /^Translate/ }).isVisible(), "real popup document ready with actual native host tab")
    await popup.getByRole("button", { name: /^Translate/ }).click()
    await until(() => worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === "receiver-state")), "real content manager waits for its saved-state reply")
    await h.reloadExtension()
    await page.bringToFront()
    await page.waitForTimeout(1400)
    assert.equal(await page.locator("[data-vibe-reading-host-toast]").count(), 0, "old pending receiver disposed")
    assert.deepEqual(h.errors, [], "late pending receive must not create an unhandled rejection")
    if (!popup.isClosed())
      await popup.close()
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "new host after pending manager reload")
    await page.keyboard.press("Alt+KeyE")
    await until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === true, "fresh page manager confirms its real state")
    await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() > 0, "fresh manager completes translation")
  })
}
