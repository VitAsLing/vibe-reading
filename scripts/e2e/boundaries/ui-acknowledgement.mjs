import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { delayNativeConfigCommit, holdConfigSubmission, releaseConfigSubmission, submissionHeld } from "./config-concurrency.mjs"

function holdActualThemeFailures() {
  const set = globalThis.chrome.storage.local.set.bind(globalThis.chrome.storage.local)
  const state = globalThis.__E2E_THEME_FAILURES__ = { plans: [], calls: [], held: [] }
  state.release = (label) => {
    const held = state.held.find(entry => entry.label === label)
    if (!held)
      throw new Error(`No actual native theme failure: ${label}`)
    state.held.splice(state.held.indexOf(held), 1)
    held.release()
  }
  globalThis.chrome.storage.local.set = (...args) => {
    const plan = state.plans.find(entry => entry.value === args[0]?.theme)
    if (!plan)
      return set(...args)
    state.plans.splice(state.plans.indexOf(plan), 1)
    const call = { label: plan.label, value: plan.value, forwarded: true, settled: false }
    state.calls.push(call)
    return set(...args).then((result) => {
      call.unexpectedSuccess = true
      call.settled = true
      return result
    }, error => new Promise((resolve, reject) => {
      call.nativeError = error.message
      state.held.push({ label: plan.label, release: () => {
        call.settled = true
        reject(error)
      } })
    }))
  }
}

function holdActualThemeSuccess() {
  const set = globalThis.chrome.storage.local.set.bind(globalThis.chrome.storage.local)
  const state = globalThis.__E2E_THEME_SUCCESS__ = { plans: [], calls: [], held: [] }
  state.release = (label) => {
    const held = state.held.find(entry => entry.label === label)
    if (!held)
      throw new Error(`No actual native theme success: ${label}`)
    state.held.splice(state.held.indexOf(held), 1)
    held.release()
  }
  globalThis.chrome.storage.local.set = (...args) => {
    const plan = state.plans.find(entry => entry.value === args[0]?.theme)
    if (!plan)
      return set(...args)
    state.plans.splice(state.plans.indexOf(plan), 1)
    const call = { label: plan.label, value: plan.value, forwarded: true, nativeSucceeded: false, settled: false }
    state.calls.push(call)
    return set(...args).then(result => new Promise((resolve) => {
      call.nativeSucceeded = true
      state.held.push({ label: plan.label, release: () => {
        call.settled = true
        resolve(result)
      } })
    }))
  }
}

function observeNativeModelReplies() {
  const fetch = globalThis.fetch.bind(globalThis)
  const state = globalThis.__E2E_MODEL_REPLIES__ = { parsed: [] }
  globalThis.fetch = (...args) => fetch(...args).then((response) => {
    if (String(args[0]).endsWith("/models")) {
      const json = response.json.bind(response)
      response.json = () => json().then((result) => {
        state.parsed.push(result.data.map(item => item.id))
        return result
      })
    }
    return response
  })
}

function delayLocaleSaves() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const get = globalThis.chrome.storage.local.get.bind(globalThis.chrome.storage.local)
  const state = globalThis.__E2E_LOCALE_SAVES__ = { labels: [], held: [], calls: [], messages: false }
  state.release = (label) => {
    const held = state.held.find(item => item.label === label)
    if (!held)
      throw new Error(`No held locale save: ${label}`)
    state.held.splice(state.held.indexOf(held), 1)
    held.forward()
  }
  globalThis.chrome.storage.local.get = (...args) => {
    if (state.messages || args[0] !== "config" || !state.labels.length)
      return get(...args)
    const label = state.labels.shift()
    const call = { label, boundary: "native-read", forwarded: true, settled: false }
    state.calls.push(call)
    return get(...args).then(result => new Promise(resolve => state.held.push({ label, forward: () => {
      call.settled = true
      resolve(result)
    } })))
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && value.type)
    if (message?.type !== "saveConfiguration" || !message.data.patch.uiLocale || !state.labels.length)
      return send(...args)
    state.messages = true
    const label = state.labels.shift()
    const call = { label, boundary: "native-message", forwarded: false, settled: false }
    state.calls.push(call)
    return new Promise((resolve, reject) => state.held.push({ label, forward: () => {
      call.forwarded = true
      send(...args).then((reply) => {
        call.settled = true
        resolve(reply)
      }, (error) => {
        call.settled = true
        reject(error)
      })
    } }))
  }
}

export async function runUIAcknowledgementCases(h) {
  const worker = await h.extensionWorker()
  const config = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
  const theme = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("theme")).theme)
  const scratch = "__e2e_theme_quota__"
  const saveFailureLabels = new Set()
  const ready = async (ui, selector) => {
    await h.until(() => ui.locator(selector).isVisible(), "the real options settings are mounted")
    await h.until(() => ui.evaluate(() => {
      const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config") || call.keys.includes("theme"))
      return reads.length >= 3 && reads.every(call => call.settled)
    }), "native bootstrap and hydration reads complete before the action")
  }
  const open = async (route, selector, scripts = []) => {
    const ui = await h.context.newPage()
    await ui.addInitScript(h.installStorageBoundary)
    await ui.addInitScript(delayNativeConfigCommit)
    for (const script of scripts)
      await ui.addInitScript(script)
    await ui.goto(`chrome-extension://${h.extensionId}/options.html#${route}`)
    await ui.bringToFront()
    await ready(ui, selector)
    return ui
  }
  const record = async (ui, name, phase, extra = {}) => {
    await writeFile(path.join(h.outputPath, `${name}-${phase}.json`), JSON.stringify({
      phase,
      errors: h.errors,
      toasts: await ui.locator("[data-sonner-toast]").allTextContents(),
      native: await ui.evaluate(() => ({ storage: globalThis.__E2E_NATIVE_STORAGE__.calls, commits: globalThis.__E2E_CONFIG_COMMITS__.calls })),
      ...extra,
    }, null, 2))
    await ui.screenshot({ path: path.join(h.outputPath, `${name}-${phase}.png`) })
  }
  const selectTheme = async (ui, value) => {
    await ui.locator("#appearance").getByRole("combobox").click()
    await ui.getByRole("option", { name: value, exact: true }).click()
  }
  const fillQuota = () => worker.evaluate(async (key) => {
    const storage = globalThis.chrome.storage.local
    const quota = storage.QUOTA_BYTES
    let length = quota - await storage.getBytesInUse(null) - key.length - 2
    for (let attempt = 0; attempt < 3; attempt++) {
      await storage.set({ [key]: "x".repeat(length) })
      const bytes = await storage.getBytesInUse(null)
      if (bytes === quota)
        return { quota, bytes }
      length += quota - bytes
    }
    throw new Error("Disposable Chrome storage did not reach its actual local quota")
  }, scratch)
  const rejectSave = async (ui, label) => {
    saveFailureLabels.add(label)
    await worker.evaluate(h.installStorageBoundary)
    for (const surface of [ui, worker]) {
      await surface.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "reject", label: value }), label)
    }
  }
  const clearSaveFailures = async (ui) => {
    for (const surface of [worker, ...(ui && !ui.isClosed() ? [ui] : [])]) {
      await surface.evaluate((labels) => {
        const state = globalThis.__E2E_NATIVE_STORAGE__
        if (state)
          state.plans = state.plans.filter(plan => !labels.includes(plan.label))
      }, [...saveFailureLabels])
    }
  }
  const awaitSaveFailure = async (ui, label) => {
    await h.until(async () => (await Promise.all([ui, worker].map(surface => surface.evaluate(value =>
      globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.settled), label)))).some(Boolean), "the actual native save read fails")
    for (const surface of [ui, worker]) {
      await surface.evaluate((value) => {
        globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== value)
      }, label)
    }
    await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the actual save failure is visible")
  }

  for (const allFailed of [false, true]) {
    const name = allFailed ? "ui-theme-all-failed-writes-restore-confirmed-theme" : "ui-theme-old-failure-preserves-new-success"
    await h.check(name, async () => {
      const previous = await theme()
      let ui
      try {
        await worker.evaluate(() => globalThis.chrome.storage.local.set({ theme: "dark" }))
        ui = await open("/", "#appearance", [holdActualThemeFailures])
        const quota = await fillQuota()
        await ui.evaluate(value => globalThis.__E2E_THEME_FAILURES__.plans.push({ label: "old-system", value: "system" }, ...(value ? [{ label: "new-light", value: "light" }] : [])), allFailed)
        await selectTheme(ui, "System")
        await h.until(() => ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.held.some(entry => entry.label === "old-system")), "first actual native quota failure is held")
        assert.match(await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.calls[0].nativeError), /quota/i)
        if (!allFailed)
          await worker.evaluate(key => globalThis.chrome.storage.local.remove(key), scratch)
        await selectTheme(ui, "Light")
        if (allFailed) {
          await h.until(() => ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.held.some(entry => entry.label === "new-light")), "the second actual quota failure is held independently")
          assert.equal(await theme(), "dark", "two rejected native writes must leave the confirmed storage value unchanged")
        }
        else {
          await h.until(async () => await theme() === "light", "the independent second theme save succeeds before the first error returns")
        }
        await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.release("old-system"))
        if (allFailed)
          await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.release("new-light"))
        await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const appearance = await ui.locator("#appearance").getByRole("combobox").textContent()
        await record(ui, name, "late-native-error", { quota, storedTheme: await theme(), appearance, calls: await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.calls) })
        assert.ok(appearance.includes(allFailed ? "Dark" : "Light"), allFailed
          ? "all failed writes must restore the last confirmed theme, not another unconfirmed optimistic value"
          : "an old failure must not roll back a newer confirmed theme")
        await worker.evaluate(key => globalThis.chrome.storage.local.remove(key), scratch)
        await selectTheme(ui, allFailed ? "Light" : "Dark")
        await h.until(async () => await theme() === (allFailed ? "light" : "dark"), "a new theme action succeeds after the failures")
        await record(ui, name, "recovered", { storedTheme: await theme() })
      }
      finally {
        await worker.evaluate(key => globalThis.chrome.storage.local.remove(key), scratch)
        if (ui && !ui.isClosed()) {
          await ui.evaluate(() => {
            for (const held of [...globalThis.__E2E_THEME_FAILURES__.held])
              globalThis.__E2E_THEME_FAILURES__.release(held.label)
          })
          await ui.close()
        }
        await worker.evaluate(value => value === undefined ? globalThis.chrome.storage.local.remove("theme") : globalThis.chrome.storage.local.set({ theme: value }), previous)
      }
    })
  }

  await h.check("ui-theme-old-success-ack-preserves-newer-confirmation", async () => {
    const name = "ui-theme-old-success-ack-preserves-newer-confirmation"
    const previous = await theme()
    let ui
    try {
      await worker.evaluate(() => globalThis.chrome.storage.local.set({ theme: "dark" }))
      ui = await open("/", "#appearance", [holdActualThemeFailures, holdActualThemeSuccess])
      await ui.evaluate(() => globalThis.__E2E_THEME_SUCCESS__.plans.push({ label: "old-system-success", value: "system" }))
      await selectTheme(ui, "System")
      await h.until(() => ui.evaluate(() => globalThis.__E2E_THEME_SUCCESS__.held.some(entry => entry.label === "old-system-success")), "the actual native successful theme write is held after persistence")
      assert.equal(await theme(), "system", "the first native write must be persisted before holding its acknowledgement")
      await worker.evaluate(() => globalThis.chrome.storage.local.set({ theme: "dark" }))
      await h.until(async () => (await ui.locator("#appearance").getByRole("combobox").textContent()).includes("Dark"), "a foreign native storage change is visible before the old acknowledgement returns")
      await ui.evaluate(() => globalThis.__E2E_THEME_SUCCESS__.release("old-system-success"))
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const quota = await fillQuota()
      await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.plans.push({ label: "latest-light-failure", value: "light" }))
      await selectTheme(ui, "Light")
      await h.until(() => ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.held.some(entry => entry.label === "latest-light-failure")), "the next independent theme write reaches a real quota failure")
      assert.match(await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.calls[0].nativeError), /quota/i)
      await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.release("latest-light-failure"))
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the next genuine storage failure is reported")
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const appearance = await ui.locator("#appearance").getByRole("combobox").textContent()
      await record(ui, name, "next-native-error", { quota, storedTheme: await theme(), appearance, successes: await ui.evaluate(() => globalThis.__E2E_THEME_SUCCESS__.calls), failures: await ui.evaluate(() => globalThis.__E2E_THEME_FAILURES__.calls) })
      assert.equal(await theme(), "dark", "the genuine failed write must preserve the later foreign confirmed theme")
      assert.ok(appearance.includes("Dark"), "an old success acknowledgement must not replace newer confirmation used to roll back the next failed write")
      await worker.evaluate(key => globalThis.chrome.storage.local.remove(key), scratch)
      await selectTheme(ui, "Light")
      await h.until(async () => await theme() === "light", "a fresh independent theme write still succeeds after the old acknowledgement and genuine failure")
      await record(ui, name, "recovered", { storedTheme: await theme() })
    }
    finally {
      await worker.evaluate(key => globalThis.chrome.storage.local.remove(key), scratch)
      if (ui && !ui.isClosed()) {
        await ui.evaluate(() => {
          for (const held of [...globalThis.__E2E_THEME_SUCCESS__.held])
            globalThis.__E2E_THEME_SUCCESS__.release(held.label)
          for (const held of [...globalThis.__E2E_THEME_FAILURES__.held])
            globalThis.__E2E_THEME_FAILURES__.release(held.label)
        })
        await ui.close()
      }
      await worker.evaluate(value => value === undefined ? globalThis.chrome.storage.local.remove("theme") : globalThis.chrome.storage.local.set({ theme: value }), previous)
    }
  })

  await h.check("ui-locale-late-save-confirmation-preserves-latest-choice", async () => {
    const name = "ui-locale-late-save-confirmation-preserves-latest-choice"
    const previous = await config()
    let ui
    let navigations = 0
    try {
      await h.configure({ uiLocale: "en" })
      ui = await open("/", "#interface-language", [delayLocaleSaves])
      ui.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === ui.mainFrame())
          navigations++
      })
      await ui.evaluate(() => globalThis.__E2E_LOCALE_SAVES__.labels.push("locale-first", "locale-latest"))
      await ui.locator("#interface-language").getByRole("combobox").click()
      await ui.getByRole("option", { name: "Simplified Chinese", exact: true }).click()
      await h.until(() => ui.evaluate(() => globalThis.__E2E_LOCALE_SAVES__.held.some(item => item.label === "locale-first")), "first actual locale save is held")
      await ui.locator("#interface-language").getByRole("combobox").click()
      await ui.getByRole("option", { name: "English", exact: true }).click()
      await ui.evaluate(() => globalThis.__E2E_LOCALE_SAVES__.release("locale-first"))
      await h.until(async () => {
        if (navigations > 0)
          return true
        try {
          return await ui.evaluate(() => globalThis.__E2E_LOCALE_SAVES__.held.some(item => item.label === "locale-latest"))
        }
        catch (error) {
          if (/Execution context was destroyed|Cannot find context/i.test(error.message))
            return navigations > 0
          throw error
        }
      }, "the latest locale save starts or an obsolete confirmation prematurely reloads")
      await ui.waitForTimeout(100)
      const premature = navigations > 0
      await record(ui, name, "first-confirmed-latest-pending", { premature, navigations, savedLocale: (await config()).uiLocale })
      assert.equal(premature, false, "an older locale confirmation must not reload while the latest user choice is still pending")
      await ui.evaluate(() => globalThis.__E2E_LOCALE_SAVES__.release("locale-latest"))
      await h.until(async () => (await config()).uiLocale === "en" && navigations === 1, "only the latest confirmed locale reloads the real document")
      await ready(ui, "#interface-language")
      assert.ok((await ui.locator("#interface-language").getByRole("combobox").textContent()).includes("English"))
      assert.equal(await ui.getByText("Interface Language", { exact: true }).count(), 1, "loaded interface messages must agree with the latest saved locale")
      await record(ui, name, "latest-confirmed", { navigations, savedLocale: (await config()).uiLocale })
    }
    finally {
      if (ui && !ui.isClosed()) {
        await ui.evaluate(() => {
          for (const held of [...(globalThis.__E2E_LOCALE_SAVES__?.held ?? [])])
            globalThis.__E2E_LOCALE_SAVES__.release(held.label)
        })
        await ui.close()
      }
      await h.configure(previous)
    }
  })

  await h.check("ui-provider-json-failed-autosave-retains-retryable-draft", async () => {
    const name = "ui-provider-json-failed-autosave-retains-retryable-draft"
    const previous = await config()
    const draft = { "X-Acceptance": "retained-json-draft" }
    let ui
    try {
      await h.configure({ uiLocale: "en" })
      ui = await open("/api-providers", "#name")
      await ui.getByText("Advanced Options", { exact: true }).click()
      const editor = ui.locator("[aria-label=provider-headers-editor] .cm-content[contenteditable=true], .cm-content[aria-label=provider-headers-editor][contenteditable=true]")
      await h.until(() => editor.isVisible(), "the real CodeMirror headers editor is visible")
      await rejectSave(ui, "json-save-failure")
      await editor.fill(JSON.stringify(draft))
      await awaitSaveFailure(ui, "json-save-failure")
      assert.deepEqual((await config()).providersConfig.find(provider => provider.id === "e2e-local").headers, previous.providersConfig.find(provider => provider.id === "e2e-local").headers)
      const retained = await editor.textContent()
      await record(ui, name, "save-failed", { retained })
      assert.deepEqual(JSON.parse(retained), draft, "the failed focused autosave must preserve its editable draft")
      await editor.fill(JSON.stringify(draft, null, 2))
      await h.until(async () => (await config()).providersConfig.find(provider => provider.id === "e2e-local").headers?.["X-Acceptance"] === draft["X-Acceptance"],
        "an explicit same-value edit can retry the previously failed JSON save")
      await record(ui, name, "same-value-recovered", { saved: (await config()).providersConfig.find(provider => provider.id === "e2e-local").headers })
    }
    finally {
      await clearSaveFailures(ui)
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })

  await h.check("ui-css-pending-save-is-not-acknowledged-and-failure-recovers", async () => {
    const name = "ui-css-pending-save-is-not-acknowledged-and-failure-recovers"
    const previous = await config()
    const css = "[data-vibe-reading-custom-translation-style='custom'] { color: #123456; }"
    let ui
    try {
      await h.configure({ uiLocale: "en", translate: { translationNodeStyle: { ...previous.translate.translationNodeStyle, isCustom: true } } })
      ui = await open("/translation", "#custom-translation-style")
      const card = ui.locator("#custom-translation-style")
      const editor = card.locator(".cm-content[contenteditable=true]")
      await editor.fill(css)
      await h.until(() => card.getByRole("button", { name: "Save", exact: true }).isEnabled(), "valid edited CSS can be saved through its actual button")
      await holdConfigSubmission(ui, "css-pending")
      await card.getByRole("button", { name: "Save", exact: true }).click()
      const held = await submissionHeld(h, ui, "css-pending")
      const savedWhilePending = await card.getByRole("button", { name: "Saved", exact: true }).count()
      await record(ui, name, "native-save-pending", { held, savedWhilePending, storedCSS: (await config()).translate.translationNodeStyle.customCSS })
      await releaseConfigSubmission(ui, "css-pending")
      await h.until(async () => (await config()).translate.translationNodeStyle.customCSS === css, "the initial CSS save finishes in actual storage")
      assert.equal(savedWhilePending, 0, "a pending native CSS save must not claim to be Saved")
      const changed = css.replace("#123456", "#654321")
      await editor.fill(changed)
      await h.until(() => card.getByRole("button", { name: "Save", exact: true }).isEnabled(), "a separate CSS draft passes validation")
      await rejectSave(ui, "css-save-failure")
      await card.getByRole("button", { name: "Save", exact: true }).click()
      await awaitSaveFailure(ui, "css-save-failure")
      assert.equal((await config()).translate.translationNodeStyle.customCSS, css)
      assert.equal(await editor.textContent(), changed)
      await card.getByRole("button", { name: "Save", exact: true }).click()
      await h.until(async () => (await config()).translate.translationNodeStyle.customCSS === changed, "the retained CSS draft saves on a later deliberate retry")
      await record(ui, name, "retained-draft-recovered", { storedCSS: changed })
    }
    finally {
      await clearSaveFailures(ui)
      if (ui && !ui.isClosed()) {
        await releaseConfigSubmission(ui, "css-pending")
        await ui.close()
      }
      await h.configure(previous)
    }
  })

  await h.check("ui-prompt-edit-failed-save-keeps-draft", async () => {
    const name = "ui-prompt-edit-failed-save-keeps-draft"
    const previous = await config()
    const original = { id: "edit-draft-acceptance", name: "Original acceptance prompt", systemPrompt: "", prompt: "Original fictional prompt input" }
    let ui
    try {
      await h.configure({ uiLocale: "en", translate: { customPromptsConfig: { promptId: null, patterns: [original] } } })
      ui = await open("/translation", "#personalized-prompts")
      const card = ui.locator("[data-slot=card]").filter({ hasText: original.name })
      await card.locator("button").last().click()
      const editor = ui.getByRole("dialog")
      await h.until(() => editor.isVisible(), "the actual prompt edit sheet opens")
      await editor.locator("#prompt-name").fill("Retained unsaved prompt name")
      await rejectSave(ui, "prompt-edit-failure")
      await editor.getByRole("button", { name: "Save Changes", exact: true }).click()
      await awaitSaveFailure(ui, "prompt-edit-failure")
      await record(ui, name, "save-failed", { editorVisible: await editor.isVisible(), saved: (await config()).translate.customPromptsConfig })
      assert.equal(await editor.isVisible(), true, "a failed prompt save must retain the open editor and draft")
      assert.equal(await editor.locator("#prompt-name").inputValue(), "Retained unsaved prompt name")
      await editor.getByRole("button", { name: "Save Changes", exact: true }).click()
      await h.until(async () => (await config()).translate.customPromptsConfig.patterns[0].name === "Retained unsaved prompt name", "the retained prompt draft is saved by an independent retry")
      await h.until(async () => await editor.count() === 0, "the confirmed save closes its editor")
      await record(ui, name, "saved-retry", { saved: (await config()).translate.customPromptsConfig })
    }
    finally {
      await clearSaveFailures(ui)
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })

  await h.check("ui-provider-delete-failure-preserves-bindings-and-list", async () => {
    const name = "ui-provider-delete-failure-preserves-bindings-and-list"
    const previous = await config()
    const original = previous.providersConfig.find(provider => provider.id === "e2e-local")
    const backup = { ...original, id: "e2e-delete-backup", name: "Deletion backup provider" }
    let ui
    try {
      await h.configure({ uiLocale: "en", providersConfig: [...previous.providersConfig, backup] })
      const before = await config()
      ui = await open("/api-providers", "#name")
      await worker.evaluate(h.installStorageBoundary)
      await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.plans.push(
        { area: "local", method: "get", key: "config", action: "hold", label: "legacy-delete-first" },
        { area: "local", method: "get", key: "config", action: "reject", label: "legacy-delete-second" },
      ))
      await worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "reject", label: "atomic-delete" }))
      await ui.getByRole("button", { name: "Delete", exact: true }).click()
      await ui.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
      await h.until(async () => await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.held.some(item => item.label === "legacy-delete-first"))
        || await worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === "atomic-delete" && call.settled)),
      "the actual provider deletion reaches the controlled native commit boundary")
      const legacy = await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.held.some(item => item.label === "legacy-delete-first"))
      if (legacy) {
        await worker.evaluate(() => {
          globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== "atomic-delete")
        })
        await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.release("legacy-delete-first"))
      }
      else {
        await ui.evaluate(() => {
          globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => !plan.label.startsWith("legacy-delete-"))
        })
      }
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the real failed deletion is visible")
      const failed = await config()
      await record(ui, name, "failed-delete", { legacy, originalProviderId: before.translate.providerId, failedProviderId: failed.translate.providerId, remainingIds: failed.providersConfig.map(provider => provider.id) })
      assert.deepEqual(failed.providersConfig, before.providersConfig, "a failed deletion must retain the real provider list")
      assert.equal(failed.translate.providerId, before.translate.providerId, "a failed deletion must not partially commit fallback bindings")
      if (!await ui.getByRole("alertdialog").count())
        await ui.getByRole("button", { name: "Delete", exact: true }).click()
      await ui.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
      await h.until(async () => !(await config()).providersConfig.some(provider => provider.id === original.id), "one deliberate retry deletes the original provider")
      assert.equal((await config()).translate.providerId, backup.id, "confirmed deletion also switches the provider binding")
      await record(ui, name, "confirmed-delete", { remainingIds: (await config()).providersConfig.map(provider => provider.id) })
    }
    finally {
      await worker.evaluate(() => {
        globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== "atomic-delete")
      })
      if (ui && !ui.isClosed()) {
        await ui.evaluate(() => {
          if (globalThis.__E2E_NATIVE_STORAGE__.held.some(item => item.label === "legacy-delete-first"))
            globalThis.__E2E_NATIVE_STORAGE__.release("legacy-delete-first")
          globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => !plan.label.startsWith("legacy-delete-"))
        })
        await ui.close()
      }
      await h.configure(previous)
    }
  })

  await h.check("ui-model-list-old-credential-response-is-discarded", async () => {
    const name = "ui-model-list-old-credential-response-is-discarded"
    const previous = await config()
    let ui
    let release
    let oldReplySent = false
    const oldKey = "e2e-old-model-account"
    const newKey = "e2e-new-model-account"
    try {
      await h.configure({ uiLocale: "en", providersConfig: previous.providersConfig.map(provider => provider.id === "e2e-local" ? { ...provider, apiKey: oldKey } : provider) })
      ui = await open("/api-providers", "#name", [observeNativeModelReplies])
      const requests = []
      await ui.route(`${h.origin}/v1/models`, async (route) => {
        const native = await route.fetch()
        assert.equal(native.status(), 200, "the local HTTP request must really reach the fixture server")
        const oldAccount = route.request().headers().authorization === `Bearer ${oldKey}`
        requests.push({ nativeForwarded: true, oldAccount })
        if (oldAccount) {
          await new Promise((resolve) => {
            release = resolve
          })
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: oldAccount ? "old-account-model" : "new-account-model" }] }) })
        if (oldAccount)
          oldReplySent = true
      })
      await ui.getByRole("button", { name: "Fetch available models", exact: true }).click()
      await h.until(() => !!release, "the first actual model-list request is held")
      await ui.locator("#apiKey").fill(newKey)
      await h.until(async () => (await config()).providersConfig.find(provider => provider.id === "e2e-local").apiKey === newKey, "the real provider form saves its new account credentials")
      release()
      await h.until(() => oldReplySent, "the obsolete HTTP response actually returns")
      await h.until(() => ui.evaluate(() => globalThis.__E2E_MODEL_REPLIES__.parsed.some(ids => ids.includes("old-account-model"))), "the actual model consumer finishes parsing its old account reply")
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const obsolete = await ui.getByRole("option", { name: "old-account-model", exact: true }).count()
      await record(ui, name, "old-account-replied", { requests, obsoleteModels: obsolete })
      assert.equal(obsolete, 0, "the old account's model list must not be accepted after credentials change")
      await ui.getByRole("button", { name: "Fetch available models", exact: true }).click()
      await h.until(() => ui.getByRole("option", { name: "new-account-model", exact: true }).isVisible(), "the current account's independent model request succeeds")
      await ui.getByRole("option", { name: "new-account-model", exact: true }).click()
      await h.until(async () => (await config()).providersConfig.find(provider => provider.id === "e2e-local").model.customModel === "new-account-model", "selecting the current model persists through the real form")
      await record(ui, name, "current-account-recovered", { requests })
    }
    finally {
      release?.()
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })

  await h.check("ui-invalid-model-list-response-is-rejected-and-recovers", async () => {
    const name = "ui-invalid-model-list-response-is-rejected-and-recovers"
    const previous = await config()
    let ui
    let requests = 0
    try {
      await h.configure({ uiLocale: "en" })
      ui = await open("/api-providers", "#name", [observeNativeModelReplies])
      await ui.route(`${h.origin}/v1/models`, async (route) => {
        await route.fetch()
        requests++
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: requests === 1 ? { invalid: "non-string-model-id" } : "valid-recovery-model" }] }) })
      })
      await ui.getByRole("button", { name: "Fetch available models", exact: true }).click()
      await h.until(() => ui.evaluate(() => globalThis.__E2E_MODEL_REPLIES__.parsed.length === 1), "the actual model consumer parses the malformed HTTP list")
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const recovery = await ui.getByRole("button", { name: "Refresh the page", exact: true }).count()
      const retry = await ui.getByRole("button", { name: "Click to retry", exact: true }).count()
      await record(ui, name, "invalid-model-reply", { requests, recovery, retry })
      assert.equal(recovery, 0, "a non-string model identifier must not enter React labels or crash the settings document")
      assert.equal(retry, 1, "an invalid model-list response must remain an actionable query failure")
      await ui.getByRole("button", { name: "Click to retry", exact: true }).click()
      await h.until(() => ui.getByRole("option", { name: "valid-recovery-model", exact: true }).isVisible(), "a valid subsequent native model-list request recovers")
      await ui.getByRole("option", { name: "valid-recovery-model", exact: true }).click()
      await h.until(async () => (await config()).providersConfig.find(provider => provider.id === "e2e-local").model.customModel === "valid-recovery-model", "the valid model selection is saved")
      await record(ui, name, "valid-list-recovered", { requests })
    }
    finally {
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })
}
