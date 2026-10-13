import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export async function runConfigActionCases(h) {
  const worker = await h.extensionWorker()
  const readPrompts = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.translate.customPromptsConfig)
  const readConfig = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
  const upload = (ui, name, prompts) => ui.locator("#personalized-prompts input[type=file]").setInputFiles({
    name: `${name}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(prompts)),
  })
  const ready = async (ui) => {
    await h.until(() => ui.locator("#personalized-prompts").isVisible(), "the real personalized prompt settings are mounted")
    await h.until(() => ui.evaluate(() => {
      const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
      return reads.length >= 2 && reads.every(call => call.settled)
    }), "settings bootstrap and hydration completed before importing")
  }
  const open = async () => {
    const ui = await h.context.newPage()
    await ui.addInitScript(h.installStorageBoundary)
    await ui.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
    await ui.bringToFront()
    await ready(ui)
    return ui
  }
  const record = async (ui, name, phase, extra = {}) => {
    const grid = ui.locator("[aria-label=\"Personalized Prompts\"]")
    const evidence = {
      phase,
      saved: await readPrompts(),
      successToasts: await ui.locator("[data-sonner-toast]").filter({ hasText: "Import Success" }).count(),
      errorToasts: await ui.locator("[data-sonner-toast][data-type=error]").count(),
      recoveryActions: await ui.getByRole("button", { name: "Refresh the page", exact: true }).count(),
      renderedPrompts: await grid.count() ? await grid.textContent() : null,
      ...extra,
    }
    await writeFile(path.join(h.outputPath, `${name}-${phase}.json`), JSON.stringify(evidence, null, 2))
    await ui.screenshot({ path: path.join(h.outputPath, `${name}-${phase}.png`) })
    return evidence
  }

  await h.check("settings-prompt-import-failed-save-has-no-success-and-recovers", async () => {
    const name = "settings-prompt-import-failed-save-has-no-success-and-recovers"
    const previous = await readConfig()
    const prompt = { name: "Acceptance prompt import recovery", systemPrompt: "", prompt: "Translate this fictional acceptance text: {{input}}" }
    let ui
    try {
      await h.configure({ uiLocale: "en" })
      await worker.evaluate(h.installStorageBoundary)
      ui = await open()
      const label = "prompt-import-save-read"
      // Both use real Chrome storage. The legacy UI reads locally; the current
      // configuration message performs its commit read in the real worker.
      for (const surface of [ui, worker]) {
        await surface.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.plans.push({
          area: "local", method: "get", key: "config", action: "reject", label: value,
        }), label)
      }
      await upload(ui, "valid-prompt-import", [prompt])
      await h.until(async () => {
        const observed = await Promise.all([ui, worker].map(surface => surface.evaluate(value =>
          globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.forwarded && call.settled), label)))
        return observed.some(Boolean)
      }, "the real configuration save receives its injected native storage failure")
      for (const surface of [ui, worker]) {
        await surface.evaluate((value) => {
          globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== value)
        }, label)
      }
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the failed import save is exposed to the reader")
      const failed = await record(ui, name, "failed-save")
      assert.deepEqual(failed.saved, previous.translate.customPromptsConfig, "a failed save must leave the real prompt configuration unchanged")

      await ui.reload()
      await ready(ui)
      await upload(ui, "valid-prompt-import", [prompt])
      await h.until(async () => (await readPrompts()).patterns.some(item => item.name === prompt.name), "the independent next import persists the same valid file")
      await h.until(async () => await ui.locator("[data-sonner-toast]").filter({ hasText: "Import Success" }).count() === 1,
        "one success acknowledgement accompanies the completed retry")
      const recovered = await record(ui, name, "independent-import-recovered", { earlierSuccessToasts: failed.successToasts })
      assert.equal(recovered.saved.patterns.filter(item => item.name === prompt.name).length, 1, "failed imports must not leave a duplicate prompt for the successful retry")
      assert.equal(recovered.recoveryActions, 0)
      assert.equal(failed.successToasts, 0, "an import whose native save failed must never announce Import Success")
    }
    finally {
      await worker.evaluate(() => {
        globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== "prompt-import-save-read")
      })
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })

  for (const [kind, malformed] of [
    ["name-object", { name: { invalid: "object must not be rendered as a name" }, prompt: "This text is otherwise valid." }],
    ["prompt-number", { name: "Invalid numeric prompt", prompt: 42 }],
  ]) {
    const name = `settings-prompt-import-rejects-${kind}-before-ui-update`
    await h.check(name, async () => {
      const previous = await readConfig()
      let ui
      try {
        await h.configure({ uiLocale: "en" })
        ui = await open()
        await upload(ui, name, [malformed])
        await h.until(() => ui.evaluate(() => {
          const input = document.querySelector("#personalized-prompts input[type=file]")
          return (!input || input.value === "") && globalThis.__E2E_NATIVE_STORAGE__.calls.every(call => call.settled)
        }), "the real file import finishes and clears its file selection")
        await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const invalid = await record(ui, name, "invalid-file")
        assert.deepEqual(invalid.saved, previous.translate.customPromptsConfig, "non-string prompt fields must not be written to real storage")
        assert.equal(invalid.recoveryActions, 0, "an invalid imported field must be rejected before it can crash a prompt card")
        assert.equal(invalid.successToasts, 0, "invalid files must not be acknowledged as successful imports")
        assert.ok(invalid.errorToasts > 0, "invalid files must have an actionable validation error")

        const valid = { name: `Valid recovery after ${kind}`, systemPrompt: "", prompt: "Translate the fictional valid recovery input." }
        await upload(ui, `valid-after-${kind}`, [valid])
        await h.until(async () => (await readPrompts()).patterns.some(item => item.name === valid.name), "a valid file remains importable after validation fails")
        const recovered = await record(ui, name, "valid-file-recovered")
        assert.equal(recovered.saved.patterns.filter(item => item.name === valid.name).length, 1)
        assert.equal(recovered.recoveryActions, 0)
      }
      finally {
        if (ui && !ui.isClosed())
          await ui.close()
        await h.configure(previous)
      }
    })
  }
}
