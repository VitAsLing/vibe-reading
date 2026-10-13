import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

// Records and forwards real Chrome messages. The fence only acknowledges that
// preceding messages reached this context; it never changes extension state.
function installMessageObservation() {
  if (!globalThis.chrome?.runtime?.id || globalThis.__E2E_STATE_MESSAGES__)
    return
  const state = globalThis.__E2E_STATE_MESSAGES__ = { incoming: [], outgoing: [] }
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  globalThis.chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    state.incoming.push({ type: message?.type, enabled: message?.data?.enabled, code: message?.data?.detectedCode })
    if (message?.type === "__E2E_STATE_FENCE__") {
      queueMicrotask(() => respond({ fence: true }))
      return true
    }
    return false
  })
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && typeof value.type === "string")
    const entry = { type: message?.type, enabled: message?.data?.enabled, settled: false }
    state.outgoing.push(entry)
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null
    if (callback) {
      const forwarded = [...args]
      forwarded[forwarded.length - 1] = (...values) => {
        entry.settled = true
        entry.error = values[0]?.err?.message
        return callback(...values)
      }
      return send(...forwarded)
    }
    return send(...args).then((value) => {
      entry.settled = true
      entry.error = value?.err?.message
      return value
    }, (error) => {
      entry.settled = true
      entry.error = error.message
      throw error
    })
  }
}

function readBoundaryMetadata() {
  const storage = globalThis.__E2E_NATIVE_STORAGE__
  return {
    messages: globalThis.__E2E_STATE_MESSAGES__,
    storage: storage && {
      calls: storage.calls,
      plans: storage.plans,
      held: storage.held.map(entry => ({ label: entry.label })),
    },
  }
}

async function executeInFrame(worker, target, action, args = []) {
  const expression = `globalThis.chrome.scripting.executeScript({target:${JSON.stringify(target)
  },func:(${action.toString()}),args:${JSON.stringify(args)}})`
  const results = await worker.evaluate(expression)
  assert.equal(results.length, 1, "the fixture must target exactly one real iframe")
  return results[0].result
}

export async function runStateBoundaryCases(h) {
  const {
    check, page, context, origin, extensionId, extensionWorker, prepareHost,
    configure, until, nodeGesture, hasTranslation, publicMessage, inContentWorld,
    requests, installStorageBoundary, outputPath, recordMessages,
  } = h
  const evidence = []

  async function tabIdFor(targetPage, worker) {
    const id = await worker.evaluate(async (url) => {
      const tabs = await globalThis.chrome.tabs.query({})
      return tabs.find(tab => tab.url === url)?.id
    }, targetPage.url())
    assert.equal(typeof id, "number", "the fixture page must have a real Chrome tab ID")
    return id
  }

  async function installPlan(worker, plans) {
    await worker.evaluate(installStorageBoundary)
    await worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.plans.push(...value), plans)
  }

  async function waitForHold(worker, label) {
    await until(async () => await worker.evaluate(value =>
      globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === value), label),
    `real native storage result held: ${label}`)
  }

  async function releaseStorage(worker, label) {
    await worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.release(value), label)
  }

  async function cleanPlan(worker, label) {
    await worker.evaluate((value) => {
      const state = globalThis.__E2E_NATIVE_STORAGE__
      if (!state)
        return
      state.plans = state.plans.filter(plan => plan.label !== value)
      if (state.held.some(entry => entry.label === value))
        state.release(value)
    }, label)
  }

  async function settleWorkerStorage(worker) {
    await until(async () => await worker.evaluate(() => {
      const state = globalThis.__E2E_NATIVE_STORAGE__
      return !state || (!state.held.length && state.calls.every(call => call.settled))
    }), "all forwarded worker storage calls completed")
  }

  async function record(name, worker, frameTarget, popup) {
    const item = { name, worker: await worker.evaluate(readBoundaryMetadata) }
    if (frameTarget)
      item.frame = await executeInFrame(worker, frameTarget, readBoundaryMetadata)
    if (popup) {
      item.popup = await popup.evaluate(readBoundaryMetadata)
      await popup.screenshot({ path: path.join(outputPath, `${name}-popup.png`) })
    }
    evidence.push(item)
    await writeFile(path.join(outputPath, "state-boundaries.json"), JSON.stringify(evidence, null, 2))
    await recordMessages(name)
  }

  async function settleFrame(worker, target) {
    const response = await worker.evaluate(async (value) => {
      return globalThis.chrome.tabs.sendMessage(value.tabId, {
        type: "__E2E_STATE_FENCE__", id: 900000001, timestamp: Date.now(),
      }, { frameId: value.frameIds[0] })
    }, target)
    assert.equal(response?.fence, true, "the real iframe must acknowledge the message fence")
    await until(async () => {
      const state = await executeInFrame(worker, target, readBoundaryMetadata)
      return state.messages.outgoing.every(message => message.settled)
        && state.storage.calls.every(call => call.settled)
        && !state.storage.held.length
    }, "iframe native reads and public message replies completed")
    await executeInFrame(worker, target, () => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  async function inactiveFrame(name) {
    const marker = `Iframe ${name} source must remain original after page translation is denied or stopped.`
    const frameURL = `${origin}/audit-frame-${name}`
    await prepareHost(name, `<p id="top-seed">Top frame ${name
    } node translation activates the real iframe injection path.</p><iframe id="state-frame" src="${
      frameURL}" style="width:900px;height:450px"></iframe>`)
    let frame
    await until(() => {
      frame = page.frames().find(candidate => candidate.url() === frameURL)
      return !!frame
    }, "real fixture iframe loaded")
    await frame.evaluate((text) => {
      document.title = "Iframe State Article"
      document.querySelector("#article").innerHTML = "<p id=\"frame-source\"></p>"
      document.querySelector("#frame-source").textContent = text
    }, marker)
    await nodeGesture(page, "#top-seed")
    await until(() => hasTranslation(page, `Top frame ${name}`), "top-frame node translation completed")
    const worker = await extensionWorker()
    const tabId = await tabIdFor(page, worker)
    const frameId = await worker.evaluate(async ({ id, url }) => {
      return (await globalThis.chrome.webNavigation.getAllFrames({ tabId: id }))
        .find(candidate => candidate.frameId !== 0 && candidate.url === url)
        ?.frameId
    }, { id: tabId, url: frameURL })
    assert.equal(typeof frameId, "number", "Chrome must expose the real child frame")
    const target = { tabId, frameIds: [frameId] }
    await until(async () => await executeInFrame(worker, target, () =>
      window.__READ_FROG_HOST_INJECTED__ === true), "production content script injected in iframe")
    await executeInFrame(worker, target, installStorageBoundary)
    await executeInFrame(worker, target, installMessageObservation)
    await inContentWorld(`(${installMessageObservation.toString()})()`)
    await settleFrame(worker, target)
    assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false,
      "node translation must leave tab page translation disabled")
    return { worker, tabId, target, frame, marker }
  }

  async function sourceLabel(popup) {
    return (await popup.getByRole("combobox").first().textContent())?.trim()
  }

  async function settlePopup(worker, popup) {
    const response = await worker.evaluate(() => globalThis.chrome.runtime.sendMessage({
      type: "__E2E_STATE_FENCE__", id: 900000002, timestamp: Date.now(),
    }))
    assert.equal(response?.fence, true, "the production popup must receive the runtime message fence")
    await until(async () => await popup.evaluate(() =>
      globalThis.__E2E_STATE_MESSAGES__.outgoing.every(message => message.settled)),
    "popup native message replies completed")
    await popup.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  await check("state-late-enabled-reply-after-stop", async () => {
    const name = "state-late-enabled-reply-after-stop"
    const { worker, tabId, target, frame, marker } = await inactiveFrame(name)
    const label = "late-enabled-state"
    await installPlan(worker, [{ area: "session", method: "set", key: `translationState.${tabId}`, enabled: true, action: "hold", label }])
    try {
      await page.keyboard.press("Alt+KeyE")
      await waitForHold(worker, label)
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false,
        "reader stop persisted while the earlier enabled reply is pending")
      const requestStart = requests.length
      await releaseStorage(worker, label)
      await until(async () => await inContentWorld(
        "globalThis.__E2E_STATE_MESSAGES__.outgoing.some(message => message.type === 'setAndNotifyPageTranslationStateChangedByManager' && message.enabled === true && message.settled)"),
      "the earlier real enabled message completed")
      await settleFrame(worker, target)
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false,
        "a late enabled reply must not change the stopped tab state")
      assert.equal(await frame.locator(".vibe-reading-translated-content-wrapper").count(), 0,
        "a late enabled notification must not restart iframe translation")
      assert.equal(requests.slice(requestStart).filter(request => request.kind === "translation" && request.input.includes(marker)).length, 0,
        "the stopped iframe must not issue a new provider request")
    }
    finally {
      await record(name, worker, target)
      await cleanPlan(worker, label)
    }
  })

  await check("state-iframe-denied-page-start", async () => {
    const name = "state-iframe-denied-page-start"
    const { worker, target, frame, marker } = await inactiveFrame(name)
    try {
      await frame.locator("#frame-source").click()
      await page.keyboard.press("Alt+KeyE")
      await until(async () => {
        const state = await executeInFrame(worker, target, readBoundaryMetadata)
        return state.messages.outgoing.some(message =>
          message.type === "setAndNotifyPageTranslationStateChangedByManager" && message.enabled === true && message.settled)
      }, "real iframe shortcut received its page-start decision")
      await settleFrame(worker, target)
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false,
        "an iframe must not enable tab-level page translation")
      assert.equal(await frame.locator(".vibe-reading-translated-content-wrapper").count(), 0,
        "a denied iframe start must not install translated content")
      assert.equal(requests.filter(request => request.kind === "translation" && request.input.includes(marker)).length, 0,
        "a denied iframe start must not contact the provider")
      assert.equal(await frame.locator("#frame-source").textContent(), marker,
        "the denied iframe must retain its original source")
    }
    finally {
      await record(name, worker, target)
    }
  })

  await check("state-navigation-old-read-preserves-new-session", async () => {
    const name = "state-navigation-old-read-preserves-new-session"
    await prepareHost(name, "<p id=\"old-session\">Old origin page translation is active before navigating to a different local origin.</p>")
    await page.keyboard.press("Alt+KeyE")
    await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === true, "old-origin session enabled")
    const worker = await extensionWorker()
    const tabId = await tabIdFor(page, worker)
    const key = `translationState.${tabId}`
    const label = "old-navigation-state"
    await installPlan(worker, [{ area: "session", method: "get", key, action: "hold", label }])
    try {
      const nextOrigin = origin.replace("127.0.0.1", "localhost")
      assert.notEqual(nextOrigin, origin, "navigation must cross a real origin boundary")
      await page.goto(`${nextOrigin}/audit-navigation-current`)
      await waitForHold(worker, label)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "new-origin host bootstrapped")
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false, "a different origin must not inherit the old page's enabled state")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await worker.evaluate(async ({ stateKey, scope }) => {
        const state = (await globalThis.chrome.storage.session.get(stateKey))[stateKey]
        return state?.enabled === true && state.origin === scope
      }, { stateKey: key, scope: nextOrigin }), "reader's new-origin session persisted")
      await releaseStorage(worker, label)
      await settleWorkerStorage(worker)
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), true,
        "old navigation cleanup must not erase a newer page session")
      assert.equal(await worker.evaluate(async ({ stateKey, scope }) => {
        const state = (await globalThis.chrome.storage.session.get(stateKey))[stateKey]
        return state?.enabled === true && state.origin === scope
      }, { stateKey: key, scope: nextOrigin }), true, "the new origin must remain the persisted session owner")
      await page.reload()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "new session page reloaded")
      await until(() => hasTranslation(page, "A reader revisits"), "new page session recovered after reload")
    }
    finally {
      await record(name, worker)
      await cleanPlan(worker, label)
    }
  })

  await check("state-active-tab-late-cached-language", async () => {
    const name = "state-active-tab-late-cached-language"
    await prepareHost(name, "<p>English source remains valid while another tab displays a Chinese article.</p>")
    await configure({ uiLocale: "en", language: { sourceCode: "auto" } })
    const worker = await extensionWorker()
    const tabA = await tabIdFor(page, worker)
    const second = await context.newPage()
    const popup = await context.newPage()
    const label = "inactive-tab-language"
    try {
      await second.goto(`${origin}/audit-language-tab-b`)
      await until(async () => await second.locator("[data-vibe-reading-host-toast]").count() === 1, "second host tab bootstrapped")
      await second.evaluate(() => {
        history.pushState({}, "", "/audit-language-tab-b-current")
        document.title = "Chinese Current Tab"
        document.querySelector("#article").innerHTML = "<p>LANG_B_CURRENT 这是当前活动标签页的中文正文，已经完成语言检测。之前英文标签页缓存的延迟回复不能覆盖这篇中文文章的语言。正文具有足够的长度，确保真实内容脚本必须通过模型接口检测语言，而不能仅使用短文本元信息。</p>"
      })
      const tabB = await tabIdFor(second, worker)
      await until(async () => await worker.evaluate(async id =>
        (await globalThis.chrome.storage.session.get(`detectedCode.${id}`))[`detectedCode.${id}`] === "cmn", tabB),
      "Chinese tab language cached through the real host report")
      await popup.addInitScript(installMessageObservation)
      await popup.goto(`chrome-extension://${extensionId}/popup.html`)
      await until(async () => await popup.getByRole("combobox").count() >= 2, "production popup rendered")
      await until(async () => await popup.evaluate(() =>
        globalThis.__E2E_STATE_MESSAGES__.outgoing.some(message => message.type === "getDetectedCode" && message.settled)),
      "popup initial language query completed before activation race")
      await settlePopup(worker, popup)
      await second.bringToFront()
      await until(async () => (await sourceLabel(popup)).includes("Simplified Chinese"), "popup shows active Chinese tab")
      await installPlan(worker, [{ area: "session", method: "get", key: `detectedCode.${tabA}`, action: "hold", label }])
      await page.bringToFront()
      await waitForHold(worker, label)
      const before = await popup.evaluate(() => globalThis.__E2E_STATE_MESSAGES__.incoming.length)
      await second.bringToFront()
      await until(async () => await popup.evaluate(index =>
        globalThis.__E2E_STATE_MESSAGES__.incoming.slice(index).some(message => message.type === "detectedPageLanguageChanged" && message.code === "cmn"), before),
      "new active tab language notification reached the popup")
      await releaseStorage(worker, label)
      await settleWorkerStorage(worker)
      await settlePopup(worker, popup)
      assert.ok((await sourceLabel(popup)).includes("Simplified Chinese"),
        "a late cached English result from an inactive tab must not overwrite the active Chinese language")
      assert.equal(await worker.evaluate(async id =>
        (await globalThis.chrome.storage.session.get(`detectedCode.${id}`))[`detectedCode.${id}`], tabB), "cmn",
      "the current tab cache must remain Chinese")
    }
    finally {
      await record(name, worker, undefined, popup)
      await cleanPlan(worker, label)
      await popup.close()
      await second.close()
    }
  })

  await check("state-popup-old-query-preserves-new-language", async () => {
    const name = "state-popup-old-query-preserves-new-language"
    await prepareHost(name, "<p>English initial query must not overwrite a newer Chinese language notification.</p>")
    await configure({ uiLocale: "en", language: { sourceCode: "auto" } })
    const worker = await extensionWorker()
    const popup = await context.newPage()
    const label = "popup-old-language-query"
    try {
      await popup.goto(`${origin}/audit-popup-query-placeholder`)
      await until(async () => await popup.locator("[data-vibe-reading-host-toast]").count() === 1, "placeholder tab host bootstrapped")
      const popupTabId = await tabIdFor(popup, worker)
      await until(async () => await worker.evaluate(async id =>
        (await globalThis.chrome.storage.session.get(`detectedCode.${id}`))[`detectedCode.${id}`] === "eng", popupTabId),
      "the popup tab has a real cached English result")
      await popup.bringToFront()
      await popup.addInitScript(installMessageObservation)
      await installPlan(worker, [{ area: "session", method: "get", key: `detectedCode.${popupTabId}`, action: "hold", label }])
      await popup.goto(`chrome-extension://${extensionId}/popup.html`)
      await waitForHold(worker, label)
      await until(async () => await popup.getByRole("combobox").count() >= 2, "popup rendered while its initial query is pending")
      await page.bringToFront()
      await page.evaluate(() => {
        history.pushState({}, "", "/audit-popup-current-chinese")
        document.title = "Chinese New Language Notification"
        document.querySelector("#article").innerHTML = "<p>LANG_B_CURRENT 当前页面的新中文语言通知应优先于弹出界面之前发出的英文查询。即使之前查询已经从真实浏览器存储读取完成，只要它的回复更晚到达，也不能替换目前正确的中文语言标签。这里提供足够长度的正文，以通过真实内容脚本和模型接口产生语言检测结果。</p>"
      })
      await until(async () => (await sourceLabel(popup)).includes("Simplified Chinese"), "new Chinese notification displayed before old query reply")
      assert.equal(await publicMessage("getDetectedCode"), "cmn", "the current host language must already be Chinese")
      await releaseStorage(worker, label)
      await settleWorkerStorage(worker)
      await settlePopup(worker, popup)
      assert.ok((await sourceLabel(popup)).includes("Simplified Chinese"),
        "the earlier English query reply must not overwrite a newer language notification")
      assert.equal(await publicMessage("getDetectedCode"), "cmn", "popup and current host must agree after all replies settle")
    }
    finally {
      await record(name, worker, undefined, popup)
      await cleanPlan(worker, label)
      await popup.close()
    }
  })
}
