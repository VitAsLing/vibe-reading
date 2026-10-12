import assert from "node:assert/strict"
import path from "node:path"

export async function runUIBoundaryCases(h) {
  const { check, context, extensionId, extensionWorker, installStorageBoundary, until, outputPath } = h
  for (const kind of ["popup", "options"]) {
    for (const fault of ["storage", "locale"]) {
      await check(`ui-${kind}-bootstrap-${fault}-failure-recovers`, async () => {
        const ui = await context.newPage()
        await ui.addInitScript(installStorageBoundary)
        await ui.addInitScript(({ type, marker }) => {
          if (sessionStorage.getItem(marker))
            return
          sessionStorage.setItem(marker, "used")
          if (type === "storage") {
            globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "reject", label: marker })
          }
          else {
            const fetch = globalThis.fetch.bind(globalThis)
            let pending = true
            globalThis.fetch = async (...args) => {
              const reply = await fetch(...args)
              if (pending && String(args[0]).includes("/_locales/")) {
                pending = false
                return new Response("E2E locale unavailable", { status: 503 })
              }
              return reply
            }
          }
        }, { type: fault, marker: `e2e-${kind}-${fault}-bootstrap` })
        await ui.goto(`chrome-extension://${extensionId}/${kind}.html`)
        await ui.bringToFront()
        await until(async () => await ui.getByRole("button", { name: "Refresh the page", exact: true }).count() === 1, "bootstrap failure has a visible recovery action")
        await ui.screenshot({ path: path.join(outputPath, `${kind}-${fault}-bootstrap-recovery.png`) })
        const before = await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
        await ui.getByRole("button", { name: "Refresh the page", exact: true }).click()
        const ready = kind === "popup" ? ui.locator("[aria-label=\"Source\"]") : ui.locator("#interface-language")
        await until(() => ready.isVisible(), "refresh recovers the real settings document")
        const after = await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
        assert.deepEqual(after, before, "recovery refresh must not reset valid saved configuration")
        await ui.close()
      })
    }
  }

  await check("ui-popup-config-read-failure-rolls-back-and-next-save-succeeds", async () => {
    const ui = await context.newPage()
    await ui.addInitScript(installStorageBoundary)
    await ui.goto(`chrome-extension://${extensionId}/popup.html`)
    await ui.bringToFront()
    const source = ui.locator("[aria-label=\"Source\"]")
    await until(() => source.isVisible(), "popup language selector ready")
    await until(async () => await ui.evaluate(() => {
      const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.area === "local" && call.method === "get" && call.keys.includes("config"))
      return reads.length >= 2 && reads.every(call => call.settled)
    }), "bootstrap and configuration hydration reads complete before save fault")
    const current = await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.language.sourceCode)
    await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "reject", label: "save-read" }))
    await source.click()
    await ui.getByPlaceholder("Search languages...").fill("French")
    await ui.getByRole("option", { name: /French/ }).click()
    await until(async () => await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === "save-read" && call.settled)), "real queued save read failed")
    assert.equal(await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.language.sourceCode), current)
    await until(async () => (await source.textContent()).includes("English"), "failed optimistic source change rolls back")
    await until(async () => await ui.locator("[data-sonner-toast]").count() > 0, "failed save is visible to the user")
    await source.click()
    await ui.getByPlaceholder("Search languages...").fill("French")
    await ui.getByRole("option", { name: /French/ }).click()
    await until(async () => await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.language.sourceCode === "fra"), "next real save succeeds after read failure")
    await ui.close()
    await h.configure({ language: { sourceCode: "eng" } })
  })

  await check("ui-theme-late-hydration-preserves-new-theme", async () => {
    const worker = await extensionWorker()
    const previous = await worker.evaluate(async () => (await globalThis.chrome.storage.local.get("theme")).theme)
    await worker.evaluate(() => globalThis.chrome.storage.local.set({ theme: "light" }))
    const ui = await context.newPage()
    await ui.addInitScript(installStorageBoundary)
    await ui.addInitScript(() => {
      let reads = 0
      globalThis.__E2E_DELAY_THEME_READS__ = true
      const get = globalThis.chrome.storage.local.get.bind(globalThis.chrome.storage.local)
      globalThis.chrome.storage.local.get = (...args) => {
        if (args[0] === "theme" && ++reads > 1 && globalThis.__E2E_DELAY_THEME_READS__)
          globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "theme", action: "hold", label: "theme-hydration" })
        return get(...args)
      }
    })
    try {
      await ui.goto(`chrome-extension://${extensionId}/options.html`)
      await until(() => ui.locator("#interface-language").isVisible(), "settings mounted while real theme hydration replies wait")
      await until(() => ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === "theme-hydration")), "real old light-theme hydration reply held")
      await ui.evaluate(() => {
        globalThis.__E2E_DELAY_THEME_READS__ = false
      })
      await worker.evaluate(() => globalThis.chrome.storage.local.set({ theme: "dark" }))
      await until(() => ui.evaluate(() => document.documentElement.classList.contains("dark")), "new dark theme arrives through real Chrome storage events")
      await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.release("theme-hydration"))
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await ui.evaluate(() => document.documentElement.classList.contains("dark")), true, "old light-theme reads must not overwrite a newer stored theme")
      await ui.screenshot({ path: path.join(outputPath, "theme-current-dark.png") })
    }
    finally {
      await ui.close()
      await worker.evaluate(value => value === undefined ? globalThis.chrome.storage.local.remove("theme") : globalThis.chrome.storage.local.set({ theme: value }), previous)
    }
  })

  await check("ui-config-refresh-late-reply-preserves-new-settings", async () => {
    const ui = await context.newPage()
    await ui.addInitScript(installStorageBoundary)
    try {
      await ui.goto(`chrome-extension://${extensionId}/popup.html`)
      const source = ui.locator("[aria-label=\"Source\"]")
      await until(() => source.isVisible(), "real popup settings mounted")
      await until(() => ui.evaluate(() => {
        const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return reads.length >= 2 && reads.every(call => call.settled)
      }), "initial configuration reads settled")
      // Playwright keeps tabs visible. Explicitly stimulate this public DOM
      // lifecycle entry; this case does not claim native tab activation.
      await ui.evaluate(() => {
        globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config", action: "hold", label: "config-refresh" })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await until(() => ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === "config-refresh")), "old real configuration refresh reply held")
      await h.configure({ language: { sourceCode: "fra" } })
      await until(async () => (await source.textContent()).includes("French"), "new settings arrive through Chrome storage events")
      await ui.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.release("config-refresh"))
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.ok((await source.textContent()).includes("French"), "old refresh must not replace newer saved settings")
    }
    finally {
      await ui.close()
      await h.configure({ language: { sourceCode: "eng" } })
    }
  })

  await check("ui-page-shortcut-change-and-clear-updates-open-page", async () => {
    const text = "The page shortcut should follow saved settings in this already open article without requiring a page refresh."
    await h.prepareHost("page-shortcut-change", `<p id="shortcut-source">${text}</p>`)
    const previous = await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.translate.page)
    const frames = () => h.inContentWorld("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    try {
      await h.configure({ translate: { page: { ...previous, shortcut: "Alt+Q" } } })
      await frames()
      await h.page.keyboard.press("Alt+KeyE")
      await frames()
      assert.equal(await h.publicMessage("getEnablePageTranslationFromContentScript"), false, "old shortcut is inactive after changing it")
      await h.page.keyboard.press("Alt+KeyQ")
      await until(() => h.hasTranslation(h.page, text), "new shortcut translates the already open page")
      await h.page.keyboard.press("Alt+KeyQ")
      await until(async () => await h.page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "new shortcut stops and restores the source")
      await h.configure({ translate: { page: { ...previous, shortcut: "" } } })
      await frames()
      await h.page.keyboard.press("Alt+KeyQ")
      await frames()
      assert.equal(await h.publicMessage("getEnablePageTranslationFromContentScript"), false, "clearing the shortcut removes its old registration")
      assert.equal(await h.page.locator(".vibe-reading-translated-content-wrapper").count(), 0)
      await h.configure({ translate: { page: previous } })
      await frames()
      await h.page.keyboard.press("Alt+KeyE")
      await until(() => h.hasTranslation(h.page, text), "restored shortcut remains usable")
      await h.page.keyboard.press("Alt+KeyE")
      await until(async () => await h.page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "restored shortcut closes the translation")
    }
    finally {
      await h.configure({ translate: { page: previous } })
    }
  })

  await check("ui-active-mode-change-provider-failure-and-recovery", async () => {
    const initialText = "Initial mode change source must be translated before changing the saved translation mode."
    const currentText = "Current mode change source must survive a provider failure, retry, another saved mode change, and restoration."
    await h.prepareHost("mode-change", `<p id="mode-source">${initialText}</p>`)
    await h.page.locator("h1").evaluate(node => node.classList.add("notranslate"))
    const mode = h.translationMode
    const other = mode === "bilingual" ? "translationOnly" : "bilingual"
    try {
      await h.page.keyboard.press("Alt+KeyE")
      await until(() => h.hasTranslation(h.page, initialText), "initial saved mode translated the real page")
      await h.page.locator("#mode-source").evaluate((node, text) => {
        node.textContent = text
      }, currentText)
      h.setProviderStatus(401)
      await h.configure({ translate: { mode: other } })
      const error = h.page.locator("#mode-source .vibe-reading-translation-error-container")
      await until(async () => await error.count() === 1, "changed saved mode exposes the real provider error")
      assert.equal(await h.publicMessage("getEnablePageTranslationFromContentScript"), true)
      h.setProviderStatus(200)
      await error.getByRole("button").first().click()
      await until(() => h.hasTranslation(h.page, currentText), "retry recovers in the newly saved mode")
      assert.equal(await h.page.locator("#mode-source [data-vibe-reading-translation-mode]").getAttribute("data-vibe-reading-translation-mode"), other)
      await h.configure({ translate: { mode } })
      await until(async () => await h.page.locator("#mode-source [data-vibe-reading-translation-mode]").getAttribute("data-vibe-reading-translation-mode") === mode
        && await h.hasTranslation(h.page, currentText), "changing the saved mode again restarts the active page")
      await h.page.keyboard.press("Alt+KeyE")
      await until(async () => await h.page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "closing the restarted session restores its source")
      assert.equal(await h.originalDom("#mode-source"), currentText)
      await h.page.screenshot({ path: path.join(outputPath, "mode-change-restored-current-source.png") })
    }
    finally {
      h.setProviderStatus(200)
      await h.configure({ translate: { mode } })
    }
  })
}
