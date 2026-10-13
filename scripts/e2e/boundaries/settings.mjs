import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export async function installConfigurationSaveReadFault(worker, installStorageBoundary, targetURL, label) {
  await worker.evaluate(installStorageBoundary)
  await worker.evaluate(({ url, marker }) => {
    const state = globalThis.__E2E_NATIVE_STORAGE__
    state.configurationSaveFaults ??= []
    state.configurationSaveFaultListeners ??= new Map()
    const fault = { label: marker, targetURL: url.split("#")[0], observed: false }
    state.configurationSaveFaults.push(fault)
    const listener = (message, sender) => {
      if (message?.type !== "saveConfiguration" || sender.url?.split("#")[0] !== fault.targetURL)
        return
      globalThis.chrome.runtime.onMessage.removeListener(listener)
      state.configurationSaveFaultListeners.delete(marker)
      fault.observed = true
      fault.messageId = message.id
      fault.patchKeys = Object.keys(message.data.patch)
      // The real save handler is already queued. Its fresh read runs after
      // this native message event; unrelated reads cannot consume the fault.
      state.plans.push({ area: "local", method: "get", key: "config", action: "reject", label: marker })
    }
    state.configurationSaveFaultListeners.set(marker, listener)
    globalThis.chrome.runtime.onMessage.addListener(listener)
  }, { url: targetURL, marker: label })
}

export async function waitForConfigurationSaveReadFault(worker, until, label) {
  await until(() => worker.evaluate(value =>
    globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.settled), label),
  "the real background configuration save read returned the injected failure")
  const actual = await worker.evaluate((value) => {
    const state = globalThis.__E2E_NATIVE_STORAGE__
    return {
      message: state.configurationSaveFaults.find(fault => fault.label === value),
      calls: state.calls.filter(call => call.label === value),
      pendingPlans: state.plans.filter(plan => plan.label === value).length,
    }
  }, label)
  assert.equal(actual.message?.observed, true, "the fault must follow the actual settings document's public save message")
  assert.deepEqual(actual.calls, [{ area: "local", method: "get", keys: ["config"], label, forwarded: true, settled: true }],
    "exactly one real background configuration read must consume this save fault")
  assert.equal(actual.pendingPlans, 0, "the one-shot save fault must be gone before recovery")
  return actual
}

export async function removeConfigurationSaveReadFault(worker, label) {
  await worker.evaluate((value) => {
    const state = globalThis.__E2E_NATIVE_STORAGE__
    const listener = state?.configurationSaveFaultListeners?.get(value)
    if (listener) {
      globalThis.chrome.runtime.onMessage.removeListener(listener)
      state.configurationSaveFaultListeners.delete(value)
    }
    if (state)
      state.plans = state.plans.filter(plan => plan.label !== value)
  }, label)
}

function observeSettingsMessages() {
  if (!globalThis.chrome?.runtime?.id || globalThis.__E2E_SETTINGS_MESSAGES__)
    return
  const state = globalThis.__E2E_SETTINGS_MESSAGES__ = { calls: [] }
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && typeof value.type === "string")
    const entry = { type: message?.type, enabled: message?.data?.enabled, settled: false }
    state.calls.push(entry)
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
    return send(...args).then((response) => {
      entry.settled = true
      entry.error = response?.err?.message
      return response
    }, (error) => {
      entry.settled = true
      entry.error = error.message
      throw error
    })
  }
}

// Used only if Chrome's native popup cannot be exposed as a Playwright Page.
// Every query reaches Chrome. The adapter selects the actual fixture host from
// Chrome's returned tabs rather than inventing page state or tab metadata.
function selectRealHostAtTabsBoundary({ extensionId, hostURL }) {
  if (globalThis.location?.host !== extensionId)
    return
  const query = globalThis.chrome.tabs.query.bind(globalThis.chrome.tabs)
  const state = globalThis.__E2E_POPUP_TAB_SELECTION__ = { calls: [] }
  globalThis.chrome.tabs.query = async (queryInfo) => {
    const actual = await query(queryInfo)
    if (!queryInfo?.active || !queryInfo.currentWindow)
      return actual
    const all = await query({})
    const host = all.find(tab => tab.url === hostURL)
    if (!host)
      throw new Error("E2E fixture host no longer exists")
    state.calls.push({ nativeQueryForwarded: true, selectedTabId: host.id, selectedURL: host.url })
    return [host]
  }
}

export async function runSettingsBoundaryCases(h) {
  const {
    check, page, context, extensionId, extensionWorker, prepareHost, configure,
    until, publicMessage, hasTranslation, installStorageBoundary, outputPath,
  } = h
  const evidence = []
  let popupFallbackReason

  async function record(name, ui, extra = {}) {
    const metadata = await ui.evaluate(() => ({
      storage: globalThis.__E2E_NATIVE_STORAGE__ && {
        calls: globalThis.__E2E_NATIVE_STORAGE__.calls,
        held: globalThis.__E2E_NATIVE_STORAGE__.held.map(item => ({ label: item.label })),
        plans: globalThis.__E2E_NATIVE_STORAGE__.plans,
      },
      messages: globalThis.__E2E_SETTINGS_MESSAGES__?.calls,
      tabSelection: globalThis.__E2E_POPUP_TAB_SELECTION__?.calls,
    }))
    const worker = await extensionWorker()
    const backgroundSaveFaults = await worker.evaluate(() => {
      const state = globalThis.__E2E_NATIVE_STORAGE__
      return state && { messages: state.configurationSaveFaults, calls: state.calls.filter(call => call.label), plans: state.plans }
    })
    evidence.push({ name, ...extra, metadata, backgroundSaveFaults })
    await writeFile(path.join(outputPath, "settings-boundaries.json"), JSON.stringify(evidence, null, 2))
    await ui.screenshot({ path: path.join(outputPath, `${name}.png`) })
  }

  async function settledConfigReads(ui) {
    await until(async () => await ui.evaluate(() => {
      const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call =>
        call.area === "local" && call.method === "get" && call.keys.includes("config"))
      return reads.length >= 2 && reads.every(call => call.settled)
    }), "real UI bootstrap and config hydration completed before injecting a save fault")
  }

  async function openOptions(route, selector) {
    const ui = await context.newPage()
    await ui.addInitScript(installStorageBoundary)
    await ui.addInitScript(observeSettingsMessages)
    await ui.goto(`chrome-extension://${extensionId}/options.html#${route}`)
    await ui.bringToFront()
    await until(() => ui.locator(selector).isVisible(), `real options route ready: ${route}`)
    await settledConfigReads(ui)
    return ui
  }

  async function saveReadFault(ui, label) {
    const worker = await extensionWorker()
    await installConfigurationSaveReadFault(worker, installStorageBoundary, ui.url(), label)
    return worker
  }

  async function waitForFault(ui, worker, label) {
    await waitForConfigurationSaveReadFault(worker, until, label)
    await until(() => ui.evaluate(() => globalThis.__E2E_SETTINGS_MESSAGES__.calls.some(call =>
      call.type === "saveConfiguration" && call.settled && call.error === "E2E storage boundary unavailable")),
    "the actual public configuration save returned its original background read error")
    await ui.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  await check("settings-add-provider-save-failure-recovers", async () => {
    const name = "settings-add-provider-save-failure-recovers"
    await configure({ uiLocale: "en" })
    const worker = await extensionWorker()
    const previous = await worker.evaluate(async () =>
      (await globalThis.chrome.storage.local.get("config")).config.providersConfig)
    assert.ok(!previous.some(provider => provider.name === "DeepSeek"), "the fixture must start without the provider being added")
    const ui = await openOptions("/api-providers", "#api-providers")
    try {
      await ui.getByRole("button", { name: "Add Provider", exact: true }).click()
      const dialog = ui.getByRole("dialog")
      await until(() => dialog.isVisible(), "real add-provider dialog opened")
      const faultWorker = await saveReadFault(ui, "add-provider-save-read")
      await dialog.getByRole("button", { name: "DeepSeek", exact: true }).click()
      await waitForFault(ui, faultWorker, "add-provider-save-read")
      assert.equal(await dialog.isVisible(), true, "a failed provider save must leave the dialog open")
      assert.equal(await ui.locator("#api-providers").getByRole("switch").locator("..").getByText("DeepSeek", { exact: true }).count(), 0,
        "a failed save must not leave a phantom provider in the editor list")
      assert.deepEqual(await worker.evaluate(async () =>
        (await globalThis.chrome.storage.local.get("config")).config.providersConfig), previous,
      "a save-read failure must leave the real saved provider list unchanged")
      await until(async () => await ui.locator("[data-sonner-toast]").count() > 0,
        "the failed save must be visible to the user")
      await dialog.getByRole("button", { name: "DeepSeek", exact: true }).click()
      await until(async () => await worker.evaluate(async (count) => {
        const providers = (await globalThis.chrome.storage.local.get("config")).config.providersConfig
        return providers.length === count + 1 && providers.filter(provider => provider.name === "DeepSeek").length === 1
      }, previous.length), "the next provider add saved exactly once")
      await until(async () => await dialog.count() === 0, "successful provider add closed the dialog")
      assert.equal(await ui.locator("#api-providers").getByRole("switch").locator("..").getByText("DeepSeek", { exact: true }).count(), 1,
        "the successfully saved provider must appear once in the real list")
    }
    finally {
      await removeConfigurationSaveReadFault(worker, "add-provider-save-read")
      await record(name, ui)
      await ui.close()
      await configure({ providersConfig: previous })
    }
  })

  for (const kind of [
    { name: "rate", id: "translate-capacity", section: "requestQueueConfig", property: "capacity", message: "setTranslateRequestQueueConfig" },
    { name: "batch", id: "batch-maxItemsPerBatch", section: "batchQueueConfig", property: "maxItemsPerBatch", message: "setTranslateBatchQueueConfig" },
  ]) {
    await check(`settings-${kind.name}-save-failure-preserves-live-queue`, async () => {
      const name = `settings-${kind.name}-save-failure-preserves-live-queue`
      await prepareHost(name, "<p>Settings queue acceptance uses the production extension and a local model endpoint.</p>")
      await configure({ uiLocale: "en" })
      const worker = await extensionWorker()
      const previous = await worker.evaluate(async section =>
        (await globalThis.chrome.storage.local.get("config")).config.translate[section], kind.section)
      const value = previous[kind.property] + 1
      const ui = await openOptions("/translation", `#${kind.id}`)
      try {
        const faultWorker = await saveReadFault(ui, name)
        await ui.locator(`#${kind.id}`).fill(String(value))
        await waitForFault(ui, faultWorker, name)
        assert.deepEqual(await worker.evaluate(async section =>
          (await globalThis.chrome.storage.local.get("config")).config.translate[section], kind.section), previous,
        "a failed settings save must retain the actual stored queue configuration")
        assert.equal(await ui.evaluate(type =>
          globalThis.__E2E_SETTINGS_MESSAGES__.calls.filter(call => call.type === type).length, kind.message), 0,
        "a failed persistence operation must not send a live queue mutation")
        await until(async () => await ui.locator(`#${kind.id}`).inputValue() === String(previous[kind.property]),
          "failed optimistic queue setting rolled back")
        await until(async () => await ui.locator("[data-sonner-toast]").count() > 0,
          "queue save failure has visible feedback")
        await ui.locator(`#${kind.id}`).fill(String(value))
        await until(async () => await worker.evaluate(async ({ section, property, expected }) =>
          (await globalThis.chrome.storage.local.get("config")).config.translate[section][property] === expected,
        { section: kind.section, property: kind.property, expected: value }), "next queue settings save succeeded")
        await until(async () => await ui.evaluate(type =>
          globalThis.__E2E_SETTINGS_MESSAGES__.calls.some(call => call.type === type && call.settled && !call.error), kind.message),
        "the persisted queue change was acknowledged by the real background")
        assert.equal(await ui.locator(`#${kind.id}`).inputValue(), String(value),
          "successful persisted queue setting is displayed")
      }
      finally {
        await removeConfigurationSaveReadFault(worker, name)
        await record(name, ui)
        await ui.close()
        await configure({ translate: { [kind.section]: previous } })
        await publicMessage(kind.message, previous)
      }
    })
  }

  async function openHostPopup() {
    await page.bringToFront()
    const popupURL = `chrome-extension://${extensionId}/popup.html`
    if (!popupFallbackReason) {
      const browserCDP = await context.browser().newBrowserCDPSession()
      let result
      try {
        const { targetInfos: tabs } = await browserCDP.send("Target.getTargets", {
          filter: [{ type: "tab", exclude: false }],
        })
        const hostTab = tabs.find(target => target.type === "tab" && target.url === page.url())
        if (!hostTab) {
          popupFallbackReason = "Chrome did not expose a native tab target for the actual fixture host URL"
        }
        const nextPage = context.waitForEvent("page", { timeout: 4000 })
          .then(ui => ({ ui }), error => ({ pageUnavailable: error.message }))
        try {
          if (hostTab) {
            await browserCDP.send("Extensions.triggerAction", { id: extensionId, targetId: hostTab.targetId })
          }
        }
        catch (error) {
          if (!/Method not found|Extensions\.triggerAction.*(?:not found|wasn't found)|not supported|not implemented|requires.*extensions/i.test(error.message))
            throw error
          popupFallbackReason = error.message
        }
        result = await nextPage
        if (result.ui) {
          await result.ui.waitForURL(url => url.href.startsWith(popupURL), { timeout: 4000 })
          await result.ui.evaluate(observeSettingsMessages)
          await until(() => result.ui.getByRole("button", { name: /^Translate/ }).isVisible(), "native Chrome action popup opened for the actual host")
          return { ui: result.ui, mode: "native Chrome action popup" }
        }
        popupFallbackReason ??= result.pageUnavailable
        const { targetInfos } = await browserCDP.send("Target.getTargets")
        for (const target of targetInfos.filter(target => target.url.startsWith(popupURL))) {
          await browserCDP.send("Target.closeTarget", { targetId: target.targetId })
        }
      }
      finally {
        await browserCDP.detach()
      }
    }
    const ui = await context.newPage()
    await ui.addInitScript(observeSettingsMessages)
    await ui.addInitScript(selectRealHostAtTabsBoundary, { extensionId, hostURL: page.url() })
    await ui.goto(popupURL)
    await until(() => ui.getByRole("button", { name: /^Translate/ }).isVisible(), "real popup document selected the actual host through native tabs metadata")
    return { ui, mode: "popup document with real native-tabs selection boundary", nativePopupUnavailable: popupFallbackReason }
  }

  await check("settings-popup-old-start-cannot-confirm-pending-mode-restart", async () => {
    const name = "settings-popup-old-start-cannot-confirm-pending-mode-restart"
    const text = "A popup confirmation must describe an accepted page session even when changing the saved mode supersedes a pending start."
    await prepareHost(name, `<p id="popup-source">${text}</p>`)
    const mode = h.translationMode
    const other = mode === "bilingual" ? "translationOnly" : "bilingual"
    const opened = await openHostPopup()
    const oldLabel = "popup-old-start-config"
    const currentLabel = "popup-current-start-config"
    try {
      await h.setContentStoragePlan([oldLabel, currentLabel].map(label => ({ area: "local", method: "get", key: "config", action: "hold", label })))
      await opened.ui.getByRole("button", { name: /^Translate/ }).click()
      await until(() => h.inContentWorld(`globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === ${JSON.stringify(oldLabel)})`), "the original manager start waits at real Chrome configuration storage")
      await configure({ translate: { mode: other } })
      await until(() => h.inContentWorld(`globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === ${JSON.stringify(currentLabel)})`), "changing the saved mode starts a newer session whose configuration is still pending")
      await h.releaseContentStorage(oldLabel)
      await until(() => opened.ui.evaluate(() => globalThis.__E2E_SETTINGS_MESSAGES__.calls.some(call => call.type === "tryToSetEnablePageTranslationByTabId" && call.settled)), "the obsolete start returned over real Chrome messaging")
      await opened.ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false, "the current pending start has not yet been accepted")
      assert.equal(await opened.ui.getByRole("button", { name: "Show Original", exact: true }).count(), 0, "an obsolete start must not confirm the newer session while it is only starting")
      await until(() => opened.ui.locator("[data-sonner-toast]").count().then(count => count > 0), "an unconfirmed start has visible failure feedback")
      await opened.ui.getByRole("button", { name: /^Translate/ }).click()
      await h.releaseContentStorage(currentLabel)
      await until(() => hasTranslation(page, text), "the current saved mode translates after its real configuration reply arrives")
      await until(() => opened.ui.getByRole("button", { name: "Show Original", exact: true }).isVisible(), "a new popup request confirms the accepted current session")
      await opened.ui.getByRole("button", { name: "Show Original", exact: true }).click()
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false && await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "confirmed stop restores the source")
      assert.equal(await h.originalDom("#popup-source"), text)
    }
    finally {
      await record(name, opened.ui, { popupMode: opened.mode, nativePopupUnavailable: opened.nativePopupUnavailable })
      await opened.ui.close()
      await h.inContentWorld(`(() => { const state = globalThis.__E2E_NATIVE_STORAGE__; for (const label of ${JSON.stringify([oldLabel, currentLabel])}) if (state.held.some(entry => entry.label === label)) state.release(label); })()`)
      await configure({ translate: { mode } })
    }
  })

  await check("settings-popup-message-failure-recovers", async () => {
    const name = "settings-popup-message-failure-recovers"
    await prepareHost(name, "<p>The popup must confirm the actual host manager before showing page translation as enabled.</p>")
    await configure({ uiLocale: "en" })
    const oldWorker = await extensionWorker()
    const tabId = await oldWorker.evaluate(async url =>
      (await globalThis.chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url())
    assert.equal(typeof tabId, "number", "the popup must act on the real fixture host tab")
    // A genuine extension reload removes the old page's message receiver.
    // The popup request still reaches the real new background and Chrome tabs
    // messaging produces the transport failure; no message reply is fabricated.
    try {
      await oldWorker.evaluate(() => globalThis.chrome.runtime.reload())
    }
    catch (error) {
      if (!/closed|destroyed|restarted/i.test(error.message))
        throw error
    }
    let worker
    await until(() => {
      worker = context.serviceWorkers().find(candidate => candidate !== oldWorker && new URL(candidate.url()).host === extensionId)
      return !!worker
    }, "a fresh real extension worker started after reload")
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "old host context disposed after the real extension reload")
    let opened = await openHostPopup()
    try {
      await opened.ui.getByRole("button", { name: /^Translate/ }).click()
      await until(async () => await opened.ui.evaluate(() =>
        globalThis.__E2E_SETTINGS_MESSAGES__.calls.some(call => call.type === "tryToSetEnablePageTranslationByTabId" && call.settled)),
      "the real background translation request returned")
      await opened.ui.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await opened.ui.getByRole("button", { name: "Show Original", exact: true }).count(), 0,
        "a failed host-manager message must not appear as a successful translation toggle")
      await until(async () => await opened.ui.locator("[data-sonner-toast]").count() > 0,
        "the popup exposes the real manager transport failure")
      assert.equal(await worker.evaluate(async id =>
        (await globalThis.chrome.storage.session.get(`translationState.${id}`))[`translationState.${id}`]?.enabled === true, tabId), false,
      "the failed request must not manufacture an enabled page state")
      await record(`${name}-failed`, opened.ui, { popupMode: opened.mode, nativePopupUnavailable: opened.nativePopupUnavailable })
      await opened.ui.close()
      opened = null
      await page.bringToFront()
      await page.reload()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "refresh restored the real host message receiver")
      opened = await openHostPopup()
      await opened.ui.getByRole("button", { name: /^Translate/ }).click()
      await until(() => hasTranslation(page, "A reader revisits"), "a subsequent popup request translated the real host")
      await until(() => opened.ui.getByRole("button", { name: "Show Original", exact: true }).isVisible(),
        "popup reflects the confirmed active manager")
      await opened.ui.getByRole("button", { name: "Show Original", exact: true }).click()
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false
        && await page.locator(".vibe-reading-translated-content-wrapper").count() === 0,
      "the real popup stop restored the original page and persisted disabled state")
      await until(() => opened.ui.getByRole("button", { name: /^Translate/ }).isVisible(),
        "popup reflects the confirmed stopped manager")
    }
    finally {
      if (opened && !opened.ui.isClosed()) {
        await record(`${name}-final`, opened.ui, { popupMode: opened.mode, nativePopupUnavailable: opened.nativePopupUnavailable })
        await opened.ui.close()
      }
    }
  })
}
