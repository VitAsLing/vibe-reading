import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const wrapper = ".vibe-reading-translated-content-wrapper"
const errorRoot = ".vibe-reading-translation-error-container"

async function holdNativeIdle(h) {
  await h.inContentWorld(`(() => {
    const request = globalThis.requestIdleCallback.bind(globalThis);
    const cancel = globalThis.cancelIdleCallback.bind(globalThis);
    const state = globalThis.__E2E_CONTENT_IDLE__ = { calls: [], held: [], holding: true };
    globalThis.requestIdleCallback = (callback, options) => {
      const call = { id: null, reachedNativeCallback: false, completed: false, cancelled: false };
      state.calls.push(call);
      call.id = request(deadline => {
        call.reachedNativeCallback = true;
        if (state.holding) state.held.push({ callback, call });
        else { call.completed = true; callback(deadline); }
      }, options);
      return call.id;
    };
    globalThis.cancelIdleCallback = id => {
      const call = state.calls.find(entry => entry.id === id);
      if (call) call.cancelled = true;
      state.held = state.held.filter(entry => entry.call.id !== id);
      return cancel(id);
    };
    state.release = () => {
      state.holding = false;
      const held = state.held.splice(0);
      for (const entry of held) request(deadline => {
        entry.call.completed = true;
        entry.callback(deadline);
      });
      return held.length;
    };
  })()`)
}

async function releaseIdle(h) {
  const released = await h.inContentWorld("globalThis.__E2E_CONTENT_IDLE__.release()")
  const cancelled = await h.inContentWorld("globalThis.__E2E_CONTENT_IDLE__.calls.some(call => call.cancelled)")
  assert.ok(released > 0 || cancelled, "the actual forwarded callbacks must either run or have been cancelled by the ended operation")
  await h.until(() => h.inContentWorld("globalThis.__E2E_CONTENT_IDLE__.calls.every(call => call.completed || call.cancelled)"), "all forwarded idle callbacks complete or are cancelled")
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function saveEvidence(h, name, phase) {
  const documentState = await h.page.evaluate(({ wrapper, errorRoot }) => {
    const target = document.querySelector("#idle-target")
    const source = target?.querySelector("#idle-source")
    return {
      url: location.href,
      targetMarkup: target?.outerHTML,
      targetText: target?.textContent,
      targetMaxHeight: target?.style.maxHeight,
      targetLineClamp: target?.style.webkitLineClamp,
      targetOverflow: target?.style.textOverflow,
      sourceMaxHeight: source?.style.maxHeight,
      sourceLineClamp: source?.style.webkitLineClamp,
      wrappers: target?.querySelectorAll(wrapper).length,
      spinners: target?.querySelectorAll(".vibe-reading-spinner").length,
      errorRoots: document.querySelectorAll(errorRoot).length,
      originalSourceConnected: window.e2eIdleSource?.isConnected,
    }
  }, { wrapper, errorRoot })
  const idle = await h.inContentWorld("({ calls: globalThis.__E2E_CONTENT_IDLE__.calls, held: globalThis.__E2E_CONTENT_IDLE__.held.length, holding: globalThis.__E2E_CONTENT_IDLE__.holding })")
  await writeFile(path.join(h.outputPath, `${name}-${phase}.json`), JSON.stringify({
    documentState,
    idle,
    injection: "The browser's real requestIdleCallback always runs first; this boundary holds its application callback, then forwards it again through native requestIdleCallback. Extension functions and source DOM remain real.",
  }, null, 2))
  await h.page.screenshot({ path: path.join(h.outputPath, `${name}-${phase}.png`) })
  await h.recordMessages(`${name}-${phase}`)
  return documentState
}

async function preparePending(h, name) {
  const text = `IDLE_SOURCE_${name} A truncated nested source must keep its current translation operation while the browser schedules the expansion of its source styles.`
  const neighbor = `IDLE_NEIGHBOR_${name} The completed neighboring translation must remain visible throughout the suspended source callback.`
  await h.prepareHost(name, `<p id="idle-neighbor">${neighbor}</p><p id="idle-target"><span id="idle-source" style="max-height: 32px; -webkit-line-clamp: 2; text-overflow: ellipsis">${text}</span></p>`)
  await h.page.locator("h1").evaluate(node => node.classList.add("notranslate"))
  await h.nodeGesture(h.page, "#idle-neighbor")
  await h.until(() => h.hasTranslation(h.page, neighbor), "neighbor successfully translated before the delayed source callback")
  await h.page.evaluate(() => {
    window.e2eIdleSource = document.querySelector("#idle-source")
  })
  await holdNativeIdle(h)
  h.heldMarkers.set(text, "translation")
  await h.nodeGesture(h.page, "#idle-target")
  await h.until(() => h.heldResponses.some(response => response.entry.input.includes(text)), "the real provider request remains pending")
  await h.until(async () => await h.page.locator(`#idle-target ${wrapper}`).count() === 1, "the actual pending paragraph wrapper is inserted")
  await h.until(() => h.inContentWorld("globalThis.__E2E_CONTENT_IDLE__.held.length >= 2"), "native idle callbacks for both the paragraph and its nested source are held")
  await saveEvidence(h, name, "pending")
  return { text, neighbor }
}

export async function runContentCleanupCases(h) {
  await h.check("content-idle-truncation-preserves-pending-translation", async () => {
    const name = "content-idle-truncation-preserves-pending-translation"
    const { text, neighbor } = await preparePending(h, name)
    await releaseIdle(h)
    const after = await saveEvidence(h, name, "idle-completed-before-http")
    assert.equal(after.wrappers, 1, "the extension's own style expansion must not cancel the source's pending translation")
    assert.equal(after.spinners, 1, "the original in-flight translation must keep its pending indicator")
    assert.equal(await h.hasTranslation(h.page, neighbor), true, "source expansion must preserve its completed neighbor")
    h.releaseHeld(text)
    await h.waitForMessageResult("enqueueTranslateRequest", text)
    await h.until(() => h.hasTranslation(h.page, text), "the original pending request successfully installs its translation")
    assert.equal(await h.page.locator(errorRoot).count(), 0)
    await saveEvidence(h, name, "translated")
  })

  await h.check("content-idle-truncation-does-not-write-after-stop", async () => {
    const name = "content-idle-truncation-does-not-write-after-stop"
    const { text, neighbor } = await preparePending(h, name)
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === true, "page translation enabled while the manual request remains pending")
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false, "page translation stops through the actual keyboard entry")
    await h.until(async () => await h.page.locator(wrapper).count() === 0, "stopping releases every current wrapper")
    const currentText = `CURRENT_AFTER_STOP_${name} The site reused this paragraph with new text and new truncation rules after the previous page session ended.`
    await h.page.locator("#idle-target").evaluate((target, text) => {
      target.style.maxHeight = "144px"
      target.style.webkitLineClamp = "4"
      target.style.textOverflow = "ellipsis"
      target.querySelector("#idle-source").textContent = text
      target.querySelector("#idle-source").style.maxHeight = "72px"
      target.querySelector("#idle-source").style.webkitLineClamp = "3"
    }, currentText)
    const before = await saveEvidence(h, name, "new-source-after-stop")
    await releaseIdle(h)
    const after = await saveEvidence(h, name, "old-idle-released")
    assert.equal(after.targetMaxHeight, before.targetMaxHeight, "a stopped session must not overwrite the site's new max-height")
    assert.equal(after.targetLineClamp, before.targetLineClamp, "a stopped session must not overwrite the site's new line clamp")
    assert.equal(after.targetOverflow, before.targetOverflow, "a stopped session must not overwrite the site's new overflow setting")
    assert.equal(after.sourceMaxHeight, before.sourceMaxHeight, "a stopped session must not overwrite current nested source styles")
    assert.equal(after.sourceLineClamp, before.sourceLineClamp)
    assert.equal(after.targetText, currentText)
    h.releaseHeld(text)
    await h.waitForMessageResult("enqueueTranslateRequest", text)
    assert.equal(await h.page.locator(wrapper).count(), 0, "the late HTTP result remains inactive after page stop")
    assert.equal((await h.page.locator("#idle-neighbor").textContent()).trim(), neighbor)
    await h.nodeGesture(h.page, "#idle-target")
    await h.until(() => h.hasTranslation(h.page, currentText), "a new user gesture can translate the site's current source")
    await saveEvidence(h, name, "current-source-recovered")
  })

  for (const [termination, name] of [
    ["stop", "content-stop-cancels-pending-paragraph-preflight"],
    ["source-mutation", "content-source-mutation-cancels-pending-paragraph-preflight"],
    ["route", "content-route-cancels-pending-paragraph-preflight"],
  ]) {
    await h.check(name, async () => {
      const oldText = `OBSOLETE_PREFLIGHT_${name} This paragraph is stopped after its real source operation begins but before its configuration read allows any provider request.`
      const neighbor = `PREFLIGHT_NEIGHBOR_${name} The completed neighbor warms the real page context before the next paragraph is started.`
      await h.prepareHost(name, `<p id="preflight-neighbor">${neighbor}</p><p id="preflight-target">${oldText}</p>`)
      await h.page.locator("h1").evaluate(node => node.classList.add("notranslate"))
      await h.nodeGesture(h.page, "#preflight-neighbor")
      await h.until(() => h.hasTranslation(h.page, neighbor), "neighbor completes before holding the target's translation configuration")
      await h.setContentStoragePlan([
        { area: "local", method: "get", key: "config", action: "pass", label: "preflight-keydown" },
        { area: "local", method: "get", key: "config", action: "pass", label: "preflight-keyup" },
        { area: "local", method: "get", key: "config", action: "hold", label: "obsolete-paragraph-config" },
      ])
      await h.nodeGesture(h.page, "#preflight-target")
      await h.until(() => h.inContentWorld("globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === 'obsolete-paragraph-config')"), "the accepted source operation waits for its real translation configuration read")
      await h.until(async () => await h.page.locator(`#preflight-target ${wrapper}`).count() === 1, "the source operation really began before its configuration wait")
      assert.equal(await h.inContentWorld(`globalThis.__E2E_CHROME_BOUNDARY__.messages.filter(entry => entry.type === 'enqueueTranslateRequest' && entry.text === ${JSON.stringify(oldText)}).length`), 0, "the held configuration precedes any provider translation enqueue")
      const currentText = `CURRENT_PREFLIGHT_${name} The site's current source remains available for a new translation gesture after the obsolete request is cancelled.`
      if (termination === "stop") {
        await h.page.keyboard.press("Alt+KeyE")
        await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === true, "page translation enables through the real keyboard workflow")
        await h.page.keyboard.press("Alt+KeyE")
        await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false, "page translation stops every current paragraph operation")
        await h.until(async () => await h.page.locator(wrapper).count() === 0, "stopping has already removed the pending source wrapper")
        await h.page.locator("#preflight-target").evaluate((target, text) => {
          target.textContent = text
        }, currentText)
      }
      else if (termination === "route") {
        await h.page.evaluate((text) => {
          history.pushState({}, "", `${location.pathname}-new-route`)
          document.querySelector("#preflight-target").textContent = text
        }, currentText)
      }
      else {
        await h.page.locator("#preflight-target").evaluate((target, text) => {
          target.textContent = text
        }, currentText)
      }
      await h.until(async () => await h.page.locator(`#preflight-target ${wrapper}`).count() === 0, "ending the source operation removes its pending wrapper")
      await h.releaseContentStorage("obsolete-paragraph-config")
      await h.page.waitForTimeout(300)
      const native = await h.inContentWorld(`({
      runtimeId: globalThis.chrome.runtime.id,
      messages: globalThis.__E2E_CHROME_BOUNDARY__.messages.filter(entry => entry.text === ${JSON.stringify(oldText)}),
      storageCalls: globalThis.__E2E_NATIVE_STORAGE__.calls,
      heldStorage: globalThis.__E2E_NATIVE_STORAGE__.held.map(entry => ({ label: entry.label })),
    })`)
      const evidence = {
        native,
        providerRequests: h.requests.filter(request => request.kind === "translation" && request.input.includes(oldText)),
        currentText: await h.page.locator("#preflight-target").textContent(),
        wrappers: await h.page.locator(`#preflight-target ${wrapper}`).count(),
        termination,
        injection: "The first two real Chrome configuration replies are forwarded normally. The third real reply, belonging to an accepted source operation, is held until a public stop, source mutation or route change makes that operation obsolete.",
      }
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}.png`) })
      assert.equal(native.runtimeId, h.extensionId, "this cancellation must happen while the actual extension stays live")
      assert.equal(native.messages.filter(entry => entry.type === "enqueueTranslateRequest").length, 0, "an obsolete operation must not start a new provider request when its old configuration read completes")
      assert.equal(evidence.currentText, currentText)
      assert.equal(evidence.wrappers, 0)
      await h.nodeGesture(h.page, "#preflight-target")
      await h.until(() => h.hasTranslation(h.page, currentText), "a fresh gesture translates the current source after the obsolete preflight finishes")
    })
  }

  if (h.translationMode === "bilingual") {
    await h.check("content-obsolete-result-preserves-current-custom-css", async () => {
      const name = "content-obsolete-result-preserves-current-custom-css"
      const oldText = `OLD_STYLE_${name} This request begins with the previous custom style and finishes after the user saves a new style.`
      const newText = `NEW_STYLE_${name} This current paragraph must retain the newly saved custom style after an older neighboring request completes.`
      const selector = "[data-vibe-reading-custom-translation-style='custom']"
      const oldCSS = `${selector} { color: rgb(181, 31, 38) !important; }`
      const currentCSS = `${selector} { color: rgb(26, 86, 219) !important; }`
      await h.prepareHost(name, `<p id="old-style">${oldText}</p><p id="current-style">${newText}</p>`)
      await h.configure({ translate: { translationNodeStyle: { preset: "textColor", isCustom: true, customCSS: oldCSS } } })
      h.heldMarkers.set(oldText, "translation")
      await h.nodeGesture(h.page, "#old-style")
      await h.until(() => h.heldResponses.some(response => response.entry.input.includes(oldText)), "an actual provider request captures the previous source configuration")
      await h.configure({ translate: { translationNodeStyle: { preset: "textColor", isCustom: true, customCSS: currentCSS } } })
      await h.nodeGesture(h.page, "#current-style")
      await h.until(() => h.hasTranslation(h.page, newText), "the current paragraph translates with the newly saved style")
      await h.until(() => h.page.locator(`#current-style ${selector}`).evaluate(element => getComputedStyle(element).color).then(color => color === "rgb(26, 86, 219)"), "the native browser applies the new custom CSS")
      const beforeColor = await h.page.locator(`#current-style ${selector}`).evaluate(element => getComputedStyle(element).color)
      h.releaseHeld(oldText)
      await h.waitForMessageResult("enqueueTranslateRequest", oldText)
      await h.until(() => h.hasTranslation(h.page, oldText), "the original provider request completes over its real connection")
      await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const savedCSS = await (await h.extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.translate.translationNodeStyle.customCSS)
      const afterColor = await h.page.locator(`#current-style ${selector}`).evaluate(element => getComputedStyle(element).color)
      const sheets = await h.page.evaluate(() => [...document.adoptedStyleSheets].map(sheet => [...sheet.cssRules].map(rule => rule.cssText).join("\n")).filter(css => css.includes("vibe-reading-custom-translation-style")))
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify({ oldCSS, currentCSS, savedCSS, beforeColor, afterColor, sheets, injection: "Only the old HTTP provider response is held. Configuration storage, both real gestures and native CSSStyleSheet replacement remain unmodified." }, null, 2))
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}.png`) })
      assert.equal(savedCSS, currentCSS, "the user's saved setting must remain the current style")
      assert.equal(afterColor, beforeColor, "an older result must not overwrite the shared stylesheet used by an already translated current paragraph")
    })
  }
}
