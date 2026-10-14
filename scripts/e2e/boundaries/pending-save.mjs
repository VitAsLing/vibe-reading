import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { installConfigurationSaveReadFault, removeConfigurationSaveReadFault, waitForConfigurationSaveReadFault } from "./settings.mjs"

function observeSaveReplies() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_PENDING_SAVE__ = { holdNext: false, calls: [], held: [] }
  state.release = () => {
    for (const release of state.held.splice(0))
      release()
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value?.type)
    if (message?.type !== "saveConfiguration")
      return send(...args)
    const held = state.holdNext
    state.holdNext = false
    const call = { patchKeys: Object.keys(message.data.patch), forwarded: true, nativeReplied: false, delivered: false }
    state.calls.push(call)
    return send(...args).then((reply) => {
      call.nativeReplied = true
      call.error = reply?.err?.message
      const deliver = () => {
        call.delivered = true
        return reply
      }
      return held ? new Promise(resolve => state.held.push(() => resolve(deliver()))) : deliver()
    })
  }
}

export async function runPendingSaveCases(h) {
  await h.check("settings-repeated-pending-reset-does-not-confirm-failed-save", async () => {
    const worker = await h.extensionWorker()
    const read = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const before = await read()
    const label = "pending-reset-first-save"
    let ui
    try {
      await h.configure({ uiLocale: "en" })
      const initial = await read()
      ui = await h.context.newPage()
      await ui.addInitScript(h.installStorageBoundary)
      await ui.addInitScript(observeSaveReplies)
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/config`)
      await ui.bringToFront()
      await h.until(() => ui.locator("#reset-config").isVisible(), "the actual configuration page is mounted")
      await h.until(() => ui.evaluate(() => {
        const calls = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return calls.length > 0 && calls.every(call => call.forwarded && call.settled)
      }), "configuration hydration completes before the real reset action")
      await installConfigurationSaveReadFault(worker, h.installStorageBoundary, ui.url(), label)
      await ui.evaluate(() => {
        globalThis.__E2E_PENDING_SAVE__.holdNext = true
      })
      await ui.locator("#reset-config").getByRole("button", { name: "Reset Config", exact: true }).click()
      const confirmation = ui.getByRole("alertdialog")
      await confirmation.getByRole("button", { name: "Confirm", exact: true }).click()
      const fault = await waitForConfigurationSaveReadFault(worker, h.until, label)
      await h.until(() => ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.held.length === 1), "the genuine failed save reply is held after forwarding")
      const first = await ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.calls[0])
      assert.ok(first.error, "the held reply must be a real failed configuration save")
      assert.deepEqual(await read(), initial, "the rejected first reset must not have persisted defaults")
      const button = confirmation.getByRole("button", { name: "Confirm", exact: true })
      if (!await button.isDisabled())
        await button.click()
      await ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.release())
      await h.until(() => ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.calls.every(call => call.delivered)), "all forwarded real reset messages have replied")
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the original failed save is exposed")
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const saved = await read()
      const messages = await ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.calls)
      await writeFile(path.join(h.outputPath, "pending-reset-failed.json"), JSON.stringify({ fault, initial, saved, messages, dialogCount: await confirmation.count() }, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, "pending-reset-failed.png") })
      assert.deepEqual(saved, initial, "a failed pending reset must leave the real configuration unchanged")
      assert.equal(await confirmation.count(), 1, "a repeated unchanged intent must not falsely confirm a failed pending reset")
      await confirmation.getByRole("button", { name: "Confirm", exact: true }).click()
      await h.until(async () => !(await read()).providersConfig.some(provider => provider.id === "e2e-local"), "a deliberate next reset persists the actual defaults")
      await h.until(async () => await confirmation.count() === 0, "only the confirmed independent reset closes its dialog")
      await writeFile(path.join(h.outputPath, "pending-reset-recovered.json"), JSON.stringify({ saved: await read(), messages: await ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__.calls) }, null, 2))
    }
    finally {
      if (ui && !ui.isClosed()) {
        await ui.evaluate(() => globalThis.__E2E_PENDING_SAVE__?.release())
        await ui.close()
      }
      await removeConfigurationSaveReadFault(worker, label)
      await h.configure(before)
      await h.publicMessage("setTranslateRequestQueueConfig", before.translate.requestQueueConfig)
      await h.publicMessage("setTranslateBatchQueueConfig", before.translate.batchQueueConfig)
    }
  })

  await h.check("settings-reset-observes-other-document-updates", async () => {
    const worker = await h.extensionWorker()
    const read = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const before = await read()
    const pages = []
    try {
      await h.configure({ uiLocale: "en", translate: { mode: "bilingual" } })
      const reset = await h.context.newPage()
      pages.push(reset)
      await reset.goto(`chrome-extension://${h.extensionId}/options.html#/config`)
      await h.until(() => reset.locator("#reset-config").isVisible(), "the first actual document is ready to reset the bilingual configuration")
      const editor = await h.context.newPage()
      pages.push(editor)
      await editor.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await h.until(() => editor.locator("#translation-mode").isVisible(), "the independent actual mode editor is ready")
      await editor.locator("#translation-mode").getByRole("combobox").click()
      await editor.getByRole("option", { name: "Translation Only", exact: true }).click()
      await h.until(async () => (await read()).translate.mode === "translationOnly", "the other document genuinely saves the new mode")
      await reset.bringToFront()
      await reset.locator("#reset-config").getByRole("button", { name: "Reset Config", exact: true }).click()
      await reset.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click()
      await h.until(async () => await reset.getByRole("alertdialog").count() === 0, "the actual reset save reports completion")
      const saved = await read()
      await writeFile(path.join(h.outputPath, "reset-after-other-document.json"), JSON.stringify({ saved }, null, 2))
      await reset.screenshot({ path: path.join(h.outputPath, "reset-after-other-document.png") })
      assert.equal(saved.translate.mode, "bilingual", "reset must restore the default mode even after another open document changed it")
      assert.ok(!saved.providersConfig.some(provider => provider.id === "e2e-local"), "the reset genuinely persisted the default provider collection")
    }
    finally {
      for (const ui of pages)
        await ui.close()
      await h.configure(before)
      await h.publicMessage("setTranslateRequestQueueConfig", before.translate.requestQueueConfig)
      await h.publicMessage("setTranslateBatchQueueConfig", before.translate.batchQueueConfig)
    }
  })
}
