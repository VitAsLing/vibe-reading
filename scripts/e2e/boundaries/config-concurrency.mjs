import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export function delayNativeConfigCommit() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_CONFIG_COMMITS__ = { label: null, held: [], calls: [] }
  state.release = (label) => {
    for (const entry of state.held.filter(item => item.label === label)) {
      state.held.splice(state.held.indexOf(entry), 1)
      entry.forward()
    }
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && value.type)
    if (message?.type !== "saveConfiguration" || !state.label)
      return send(...args)
    const label = state.label
    state.label = null
    const call = { label, type: message.type, patchKeys: Object.keys(message.data.patch), forwarded: false, settled: false }
    state.calls.push(call)
    return new Promise((resolve, reject) => state.held.push({ label, forward: () => {
      call.forwarded = true
      send(...args).then((result) => {
        call.settled = true
        call.responseError = result?.err?.message
        resolve(result)
      }, (error) => {
        call.settled = true
        call.error = error.message
        reject(error)
      })
    } }))
  }
}

export async function holdConfigSubmission(ui, label) {
  await ui.evaluate((value) => {
    globalThis.__E2E_CONFIG_COMMITS__.label = value
    // Old builds read locally; current builds commit through public messaging.
    globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "hold", label: value })
  }, label)
}

export async function submissionHeld(h, ui, label) {
  await h.until(() => ui.evaluate(value =>
    globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === value)
    || globalThis.__E2E_CONFIG_COMMITS__.held.some(entry => entry.label === value), label),
  "the actual save waits at a native read reply or before forwarding its native configuration commit")
  return ui.evaluate((value) => {
    const messageHeld = globalThis.__E2E_CONFIG_COMMITS__.held.some(entry => entry.label === value)
    if (messageHeld) {
      globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== value)
      const call = globalThis.__E2E_CONFIG_COMMITS__.calls.find(entry => entry.label === value)
      return { boundary: "native-message-before-forward", ...call }
    }
    const call = globalThis.__E2E_NATIVE_STORAGE__.calls.find(entry => entry.label === value)
    return { boundary: "native-read-after-forward", ...call }
  }, label)
}

export async function releaseConfigSubmission(ui, label) {
  await ui.evaluate((value) => {
    if (globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === value))
      globalThis.__E2E_NATIVE_STORAGE__.release(value)
    globalThis.__E2E_CONFIG_COMMITS__.release(value)
  }, label)
}

function holdConfirmedNativeReply() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_CONFIG_ACK__ = { armed: false, held: [], calls: [] }
  state.release = () => {
    for (const entry of state.held.splice(0))
      entry.release()
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && value.type)
    if (message?.type !== "saveConfiguration" || !state.armed)
      return send(...args)
    state.armed = false
    const call = { nativeForwarded: true, nativeReplied: false, released: false }
    state.calls.push(call)
    return send(...args).then((reply) => {
      call.nativeReplied = true
      call.nativeResponseError = reply?.err?.message
      return new Promise(resolve => state.held.push({ release: () => {
        call.released = true
        resolve(reply)
      } }))
    })
  }
}

export async function runConfigConcurrencyCases(h) {
  await h.check("settings-old-save-ack-preserves-newer-storage-watch", async () => {
    const name = "settings-old-save-ack-preserves-newer-storage-watch"
    const worker = await h.extensionWorker()
    const config = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const previous = await config()
    let popup
    let options
    const onlyButton = ui => ui.getByRole("button", { name: "Click to switch to bilingual", exact: true })
    try {
      await h.configure({ uiLocale: "en", language: { sourceCode: "eng" }, translate: { mode: "bilingual" } })
      popup = await h.context.newPage()
      await popup.addInitScript(h.installStorageBoundary)
      await popup.addInitScript(holdConfirmedNativeReply)
      await popup.goto(`chrome-extension://${h.extensionId}/popup.html`)
      await h.until(() => popup.locator("[aria-label=Source]").isVisible(), "the actual popup settings are ready")
      await popup.evaluate(() => {
        globalThis.__E2E_CONFIG_ACK__.armed = true
      })
      await popup.locator("[aria-label=Source]").click()
      await popup.getByPlaceholder("Search languages...").fill("French")
      await popup.getByRole("option", { name: /French/ }).click()
      await h.until(() => popup.evaluate(() => globalThis.__E2E_CONFIG_ACK__.held.length === 1), "a genuine successful configuration reply is held only after forwarding")
      assert.equal((await config()).language.sourceCode, "fra", "the first actual save must already be committed before holding its reply")
      options = await h.context.newPage()
      await options.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await h.until(() => options.locator("#translation-mode").isVisible(), "the independent options editor is ready")
      await options.locator("#translation-mode").getByRole("combobox").click()
      await options.getByRole("option", { name: "Translation Only", exact: true }).click()
      await h.until(async () => (await config()).translate.mode === "translationOnly" && await onlyButton(popup).count() === 1,
        "the newer actual save reaches both storage and the popup's native storage watcher")
      await writeFile(path.join(h.outputPath, `${name}-new-watch.json`), JSON.stringify({ savedMode: (await config()).translate.mode, popupShowsOnly: true, calls: await popup.evaluate(() => globalThis.__E2E_CONFIG_ACK__.calls) }, null, 2))
      await popup.evaluate(() => globalThis.__E2E_CONFIG_ACK__.release())
      await popup.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
      const afterOldAck = await onlyButton(popup).count() === 1
      await popup.screenshot({ path: path.join(h.outputPath, `${name}-old-ack.png`) })
      await writeFile(path.join(h.outputPath, `${name}-old-ack.json`), JSON.stringify({ popupShowsOnly: afterOldAck, storedMode: (await config()).translate.mode }, null, 2))
      await popup.bringToFront()
      await popup.locator("[aria-label=Source]").click()
      await popup.getByPlaceholder("Search languages...").fill("German")
      await popup.getByRole("option", { name: /German/ }).click()
      await h.until(async () => (await config()).language.sourceCode === "deu", "an independent later save succeeds after the stale acknowledgement")
      assert.equal((await config()).translate.mode, "translationOnly", "the later save must retain the other document's mode")
      assert.equal(afterOldAck, true, "an old successful reply must not overwrite a newer confirmed storage watch in the popup")
    }
    finally {
      if (popup && !popup.isClosed()) {
        await popup.evaluate(() => globalThis.__E2E_CONFIG_ACK__.release())
        await popup.close()
      }
      if (options && !options.isClosed())
        await options.close()
      await h.configure(previous)
    }
  })

  await h.check("settings-two-documents-preserve-concurrent-field-saves", async () => {
    const worker = await h.extensionWorker()
    const readConfig = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const previous = await readConfig()
    let options
    let popup
    const label = "options-mode-save-old-read"
    const nextMode = h.translationMode === "translationOnly" ? "bilingual" : "translationOnly"
    const nextModeLabel = nextMode === "translationOnly" ? "Translation Only" : "Bilingual"

    const readsSettled = ui => h.until(() => ui.evaluate(() => {
      const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call =>
        call.area === "local" && call.method === "get" && call.keys.includes("config"))
      return reads.length >= 2 && reads.every(call => call.settled)
    }), "the real settings document finished bootstrap and hydration reads")

    const selectSource = async (language) => {
      await popup.bringToFront()
      await popup.locator("[aria-label=\"Source\"]").click()
      await popup.getByPlaceholder("Search languages...").fill(language)
      await popup.getByRole("option", { name: new RegExp(language) }).click()
    }

    const record = async (phase, config, extra = {}) => {
      const nativeStorage = async ui => ui.evaluate(() => ({
        calls: globalThis.__E2E_NATIVE_STORAGE__.calls,
        held: globalThis.__E2E_NATIVE_STORAGE__.held.map(entry => ({ label: entry.label })),
      }))
      await writeFile(path.join(h.outputPath, `config-concurrency-${phase}.json`), JSON.stringify({
        config,
        optionsStorage: await nativeStorage(options),
        popupStorage: await nativeStorage(popup),
        configCommit: await options.evaluate(() => globalThis.__E2E_CONFIG_COMMITS__.calls),
        optionsMode: await options.locator("#translation-mode").getByRole("combobox").textContent(),
        popupSource: await popup.locator("[aria-label=\"Source\"]").textContent(),
        ...extra,
      }, null, 2))
      await options.screenshot({ path: path.join(h.outputPath, `config-concurrency-${phase}-options.png`) })
      await popup.screenshot({ path: path.join(h.outputPath, `config-concurrency-${phase}-popup.png`) })
    }

    try {
      await h.configure({ uiLocale: "en", language: { sourceCode: "eng" }, translate: { mode: h.translationMode } })
      options = await h.context.newPage()
      await options.addInitScript(h.installStorageBoundary)
      await options.addInitScript(delayNativeConfigCommit)
      await options.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await h.until(() => options.locator("#translation-mode").isVisible(), "real translation settings ready")
      await readsSettled(options)
      popup = await h.context.newPage()
      await popup.addInitScript(h.installStorageBoundary)
      await popup.goto(`chrome-extension://${h.extensionId}/popup.html`)
      await h.until(() => popup.locator("[aria-label=\"Source\"]").isVisible(), "real popup language settings ready")
      await readsSettled(popup)

      await options.bringToFront()
      await options.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await readsSettled(options)
      await options.locator("#translation-mode").getByRole("combobox").click()
      await holdConfigSubmission(options, label)
      await options.getByRole("option", { name: nextModeLabel, exact: true }).click()
      const held = await submissionHeld(h, options, label)
      assert.equal(held.settled, false, "the user's options save must remain pending")
      assert.equal(held.forwarded, held.boundary === "native-read-after-forward",
        "native reads forward before holding their reply; native message commits hold before their actual dispatch")

      await selectSource("French")
      await h.until(async () => (await readConfig()).language.sourceCode === "fra", "the independent popup save persists French while the options read remains held")
      await record("popup-saved-before-old-read", await readConfig())
      assert.equal((await submissionHeld(h, options, label)).settled, false, "the two saves must overlap across actual extension documents")

      await releaseConfigSubmission(options, label)
      await h.until(async () => (await readConfig()).translate.mode === nextMode, "the original options gesture completes its own mode save")
      const afterOlderRead = await readConfig()
      await record("after-old-read-completed", afterOlderRead)

      // Exercise recovery even on the broken production build, before reporting
      // the preserved-field assertion. Recovery must not hide that earlier loss.
      await selectSource("German")
      await h.until(async () => (await readConfig()).language.sourceCode === "deu", "a separate next user save succeeds after the conflicting commits")
      const afterRecovery = await readConfig()
      await record("independent-next-save", afterRecovery, { preservedBeforeRecovery: afterOlderRead.language.sourceCode === "fra" })
      assert.equal(afterRecovery.translate.mode, nextMode, "the independent next save must also preserve the completed options mode")
      assert.equal(afterOlderRead.language.sourceCode, "fra", "finishing an older options save must preserve the popup field already confirmed in real storage")
    }
    finally {
      if (options && !options.isClosed()) {
        await releaseConfigSubmission(options, label)
        await h.until(() => options.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls.every(call => call.settled)), "all owned storage replies finish before closing the options document")
        await options.close()
      }
      if (popup && !popup.isClosed())
        await popup.close()
      await h.configure(previous)
    }
  })

  await h.check("settings-two-documents-reject-stale-provider-replacement-and-recover", async () => {
    const worker = await h.extensionWorker()
    const readConfig = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const previous = await readConfig()
    const provider = previous.providersConfig.find(item => item.id === "e2e-local")
    assert.ok(provider, "the disposable fixture must have its local provider")
    const label = "options-stale-provider"
    const replacementName = "Concurrent accepted provider name"
    const staleDescription = "Stale provider draft must be rejected after the other editor saves its provider."
    const nextDescription = "Independent provider update succeeds after the stale replacement is rejected."
    let first
    let second
    const ready = async (ui) => {
      await h.until(() => ui.locator("#name").isVisible(), "the real local provider form is ready")
      await h.until(() => ui.evaluate(() => {
        const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return reads.length >= 2 && reads.every(call => call.settled)
      }), "provider editor hydration settled")
    }
    try {
      await h.configure({ uiLocale: "en" })
      for (const index of [0, 1]) {
        const ui = await h.context.newPage()
        if (index === 0)
          first = ui
        else
          second = ui
        await ui.addInitScript(h.installStorageBoundary)
        await ui.addInitScript(delayNativeConfigCommit)
        await ui.goto(`chrome-extension://${h.extensionId}/options.html#/api-providers`)
        await ready(ui)
      }
      await first.bringToFront()
      await first.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await ready(first)
      await holdConfigSubmission(first, label)
      await first.locator("#description").fill(staleDescription)
      const held = await submissionHeld(h, first, label)
      assert.equal(held.settled, false)
      await second.bringToFront()
      await second.locator("#name").fill(replacementName)
      await h.until(async () => (await readConfig()).providersConfig.find(item => item.id === provider.id)?.name === replacementName,
        "the other real provider editor confirms its name save before the old commit is released")
      await releaseConfigSubmission(first, label)
      await h.until(() => first.evaluate(value =>
        globalThis.__E2E_CONFIG_COMMITS__.calls.some(call => call.label === value && call.settled)
        || globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.settled), label), "the old native save finishes")
      if (held.boundary === "native-message-before-forward") {
        await h.until(async () => await first.locator("[data-sonner-toast][data-type=error]").count() > 0,
          "the stale public configuration commit reports a visible conflict")
      }
      else {
        await h.until(() => first.evaluate(() =>
          globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.method === "set" && call.keys.includes("config") && call.settled)
          && globalThis.__E2E_NATIVE_STORAGE__.calls.every(call => call.settled)), "the legacy native provider write completes")
      }
      const afterStale = (await readConfig()).providersConfig.find(item => item.id === provider.id)
      const conflictVisible = await first.locator("[data-sonner-toast][data-type=error]").count() > 0
      await writeFile(path.join(h.outputPath, "provider-concurrency-stale.json"), JSON.stringify({ held, afterStale, conflictVisible, calls: await first.evaluate(() => globalThis.__E2E_CONFIG_COMMITS__.calls) }, null, 2))
      await first.screenshot({ path: path.join(h.outputPath, "provider-concurrency-stale.png") })

      await first.bringToFront()
      await ready(first)
      await first.locator("#description").fill(nextDescription)
      await h.until(async () => (await readConfig()).providersConfig.find(item => item.id === provider.id)?.description === nextDescription,
        "a fresh separate provider edit succeeds after the competing submissions")
      const recovered = (await readConfig()).providersConfig.find(item => item.id === provider.id)
      await writeFile(path.join(h.outputPath, "provider-concurrency-recovered.json"), JSON.stringify({ afterStale, recovered, conflictVisible }, null, 2))
      await first.screenshot({ path: path.join(h.outputPath, "provider-concurrency-recovered.png") })
      assert.equal(afterStale.name, replacementName, "the obsolete provider group must not overwrite the already saved name")
      assert.notEqual(afterStale.description, staleDescription, "the stale provider replacement must be rejected in full")
      assert.equal(conflictVisible, true, "a conflicting replacement must be exposed as a failed save")
      assert.equal(recovered.name, replacementName, "the independent next edit must retain the other editor's saved name")
    }
    finally {
      if (first && !first.isClosed()) {
        await releaseConfigSubmission(first, label)
        await first.close()
      }
      if (second && !second.isClosed())
        await second.close()
      await h.configure(previous)
    }
  })
}
