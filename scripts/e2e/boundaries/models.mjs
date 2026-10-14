import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

async function readConfig(h) {
  return (await h.extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
}

async function restartWithSavedProviders(h, providersConfig) {
  const worker = await h.extensionWorker()
  await h.configure({ uiLocale: "en", providersConfig })
  await h.reloadExtension()
  await h.until(() => !h.context.serviceWorkers().includes(worker), "the actual old extension worker exits before configuration migration")
  assert.notEqual(await h.extensionWorker(), worker, "configuration startup runs in a newly loaded native worker")
}

async function openProviders(h, name) {
  const ui = await h.context.newPage()
  await ui.goto(`chrome-extension://${h.extensionId}/options.html#/api-providers`)
  await ui.bringToFront()
  await h.until(async () => await ui.locator("#name").inputValue() === name, "the actual options provider form selects the fixture's first saved provider")
  return ui
}

async function selectModel(h, ui, providerId, model) {
  await ui.locator("#api-providers").getByRole("combobox").click()
  await ui.getByRole("option", { name: model, exact: true }).click()
  await h.until(async () => (await readConfig(h)).providersConfig.find(provider => provider.id === providerId)?.model.model === model,
    "the real model dropdown persists its selection through the background save")
}

async function closeModelChoices(h, ui, currentModel) {
  await ui.getByRole("option", { name: currentModel, exact: true }).click()
  await h.until(async () => !await ui.getByRole("listbox").isVisible(), "choosing the current valid model closes the real dropdown before the next settings action")
}

async function setLocalEndpoint(h, ui, providerId) {
  const baseURL = `${h.origin}/v1`
  await ui.locator("#baseURL").fill(baseURL)
  await h.until(async () => (await readConfig(h)).providersConfig.find(provider => provider.id === providerId)?.baseURL === baseURL,
    "the real provider form persists the disposable local HTTP endpoint")
  await ui.getByRole("button", { name: "Feature Providers", exact: true }).click()
  await ui.getByText("Page Translation", { exact: true }).locator("..").getByRole("switch").click()
  await h.until(async () => (await readConfig(h)).translate.providerId === providerId, "the reader assigns page translation through the real provider settings switch")
}

async function translateAndRestore(h, name, model, endpoint) {
  const marker = `MODEL_HTTP_${name} A reader must receive a translation from the exact model selected and saved in the real provider settings.`
  await h.prepareHost(name, `<p id="model-target">${marker}</p>`)
  await h.page.bringToFront()
  const start = h.requests.length
  await h.page.keyboard.press("Alt+KeyE")
  await h.until(() => h.hasTranslation(h.page, marker), "the configured SDK translates the actual paragraph through the local HTTP provider")
  const request = h.requests.slice(start).find(item => item.kind === "translation" && item.input.includes(marker))
  assert.ok(request, "the visible translation must correspond to a new real HTTP request")
  assert.equal(request.model, model, "the actual provider HTTP payload uses the persisted model ID")
  assert.equal(request.endpoint, endpoint, "the actual installed SDK uses the expected provider protocol")
  assert.equal(request.status, 200)
  await h.page.keyboard.press("Alt+KeyE")
  await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false
    && await h.page.locator("#model-target .vibe-reading-translated-content-wrapper").count() === 0,
  "stopping the real page action removes its translation")
  assert.equal(await h.originalDom("#model-target"), marker, "stopping preserves the original paragraph")
  return request
}

export async function runModelBoundaryCases(h) {
  await h.check("models-openai-retired-selection-preserved-current-model-saves-and-translates", async () => {
    const name = "models-openai-retired-selection-preserved-current-model-saves-and-translates"
    const previous = await readConfig(h)
    const legacy = {
      id: "e2e-model-openai", provider: "openai", name: "E2E Official OpenAI Models", enabled: true,
      apiKey: "e2e-only-openai-model-key", baseURL: "https://api.openai.com/v1",
      model: { model: "gpt-5.3-chat-latest", isCustomModel: false, customModel: null },
      headers: { "X-Acceptance": "model-config-preserved" }, providerOptions: {}, temperature: 0.7,
    }
    let ui
    try {
      await restartWithSavedProviders(h, [legacy, ...previous.providersConfig])
      ui = await openProviders(h, legacy.name)
      const savedLegacy = (await readConfig(h)).providersConfig.find(provider => provider.id === legacy.id)
      assert.deepEqual(savedLegacy, legacy, "startup must retain the retired official model, key, headers, empty options and all saved provider fields")
      const warning = ui.getByRole("alert").filter({ hasText: "gpt-5.3-chat-latest" })
      await h.until(() => warning.isVisible(), "the real form warns about its preserved retired official model")
      assert.match(await warning.textContent(), /official API.*stopped.*2026-08-10/i)
      await ui.locator("#api-providers").getByRole("combobox").click()
      const retiredOption = ui.getByRole("option", { name: "gpt-5.3-chat-latest (retired)", exact: true })
      assert.equal(await retiredOption.getAttribute("aria-disabled"), "true", "the preserved retired selection is disabled for new choices")
      const available = await ui.getByRole("option").allTextContents()
      const activeModels = await ui.getByRole("option").evaluateAll(elements => elements
        .filter(element => element.getAttribute("aria-disabled") !== "true")
        .map(element => element.textContent))
      for (const retired of ["gpt-5-chat-latest", "gpt-5-codex", "gpt-5.1-chat-latest", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2-chat-latest", "gpt-5.3-chat-latest"])
        assert.equal(activeModels.some(model => model.includes(retired)), false, `${retired} must not be offered as an active new selection`)
      for (const current of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro"])
        assert.ok(activeModels.includes(current), `the actual model dropdown exposes ${current} as an enabled selection`)
      await ui.getByRole("option", { name: "gpt-6.1-sol", exact: true }).click()
      await h.until(async () => (await readConfig(h)).providersConfig.find(provider => provider.id === legacy.id)?.model.model === "gpt-6.1-sol", "an explicit current model choice is saved")
      const selected = (await readConfig(h)).providersConfig.find(provider => provider.id === legacy.id)
      assert.deepEqual(selected, { ...legacy, model: { ...legacy.model, model: "gpt-6.1-sol" } }, "changing the model preserves keys, headers, empty user options and every unrelated setting")
      await ui.reload()
      await h.until(() => ui.locator("#api-providers").getByRole("combobox").getByText("gpt-6.1-sol", { exact: true }).isVisible(), "a genuine options reload displays the persisted current model")
      assert.equal(await ui.getByRole("alert").filter({ hasText: "gpt-5.3-chat-latest" }).count(), 0)
      await ui.locator("#api-providers").getByRole("combobox").click()
      assert.equal(await ui.getByRole("option", { name: /gpt-5\.3-chat-latest/ }).count(), 0, "retired models cannot be reselected from the current model list")
      await closeModelChoices(h, ui, "gpt-6.1-sol")
      await setLocalEndpoint(h, ui, legacy.id)
      const request = await translateAndRestore(h, name, "gpt-6.1-sol", "/v1/responses")
      assert.deepEqual(request.testHeaders, { acceptance: "model-config-preserved", empty: null })
      assert.equal(request.reasoning, null, "an explicitly empty user-options override must not gain a recommended reasoning effort")
      const finalProvider = (await readConfig(h)).providersConfig.find(provider => provider.id === legacy.id)
      assert.deepEqual(finalProvider, { ...selected, baseURL: `${h.origin}/v1` })
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify({ prerequisite: "Only disposable fake API keys and the local HTTP fixture are used. Official provider endpoints are never invoked.", legacy, selected, finalProvider, available, activeModels, request }, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, `${name}.png`) })
    }
    finally {
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })

  await h.check("models-deepseek-flash-alias-migrates-custom-settings-preserved-and-current-models-translate", async () => {
    const name = "models-deepseek-flash-alias-migrates-custom-settings-preserved-and-current-models-translate"
    const previous = await readConfig(h)
    const legacy = {
      id: "e2e-model-deepseek", provider: "deepseek", name: "E2E Official DeepSeek Models", enabled: true,
      apiKey: "e2e-only-deepseek-model-key", baseURL: "https://api.deepseek.com",
      model: { model: "deepseek-v4-flash", isCustomModel: false, customModel: null },
      headers: { "X-Acceptance": "deepseek-config-preserved" }, temperature: 0.6,
    }
    const custom = { ...legacy, id: "e2e-model-deepseek-custom", name: "E2E Custom DeepSeek Model",
      model: { ...legacy.model, isCustomModel: true, customModel: "deepseek-v4-flash" }, providerOptions: {} }
    const privateEndpoint = { ...legacy, id: "e2e-model-deepseek-private", name: "E2E Private DeepSeek Endpoint", baseURL: `${h.origin}/private/v1`, providerOptions: {} }
    let ui
    try {
      await restartWithSavedProviders(h, [legacy, custom, privateEndpoint, ...previous.providersConfig])
      ui = await openProviders(h, legacy.name)
      const initialized = await readConfig(h)
      const migrated = initialized.providersConfig.find(provider => provider.id === legacy.id)
      assert.deepEqual(migrated, { ...legacy, model: { ...legacy.model, model: "deepseek-flash" } }, "startup migrates only the equivalent official Flash alias while preserving every other saved provider field")
      assert.deepEqual(initialized.providersConfig.find(provider => provider.id === custom.id), custom, "custom model strings and explicit empty options retain their original configuration")
      assert.deepEqual(initialized.providersConfig.find(provider => provider.id === privateEndpoint.id), privateEndpoint, "a private endpoint retains its original model alias and user options")
      await ui.locator("#api-providers").getByRole("combobox").click()
      const available = await ui.getByRole("option").allTextContents()
      assert.deepEqual(available, ["deepseek-flash", "deepseek-v4-pro"], "the official dropdown exposes both supported Flash and Pro model IDs")
      await closeModelChoices(h, ui, "deepseek-flash")
      await setLocalEndpoint(h, ui, legacy.id)
      const requests = []
      for (const model of ["deepseek-v4-pro", "deepseek-flash"]) {
        await ui.bringToFront()
        await selectModel(h, ui, legacy.id, model)
        await ui.reload()
        await h.until(() => ui.locator("#api-providers").getByRole("combobox").getByText(model, { exact: true }).isVisible(), "the chosen DeepSeek model persists across an actual options page reload")
        const request = await translateAndRestore(h, `${name}-${model}`, model, "/v1/chat/completions")
        assert.deepEqual(request.thinking, { type: "disabled" }, "current DeepSeek models use the configured non-thinking translation mode in the real HTTP payload")
        assert.deepEqual(request.testHeaders, { acceptance: "deepseek-config-preserved", empty: null })
        requests.push(request)
      }
      const finalConfig = await readConfig(h)
      assert.deepEqual(finalConfig.providersConfig.find(provider => provider.id === custom.id), custom)
      assert.deepEqual(finalConfig.providersConfig.find(provider => provider.id === privateEndpoint.id), privateEndpoint)
      await ui.bringToFront()
      await ui.locator("#api-providers").getByText(privateEndpoint.name, { exact: true }).click()
      await h.until(async () => await ui.locator("#name").inputValue() === privateEndpoint.name, "the real form opens the preserved private endpoint")
      assert.equal(await ui.locator("#api-providers").getByRole("combobox").getByText("deepseek-v4-flash", { exact: true }).isVisible(), true,
        "a private endpoint's preserved legacy selection retains its visible model label")
      await ui.locator("#api-providers").getByRole("combobox").click()
      assert.equal(await ui.getByRole("option", { name: "deepseek-v4-flash", exact: true }).getAttribute("aria-disabled"), "true",
        "the preserved private alias is displayed as the current value rather than offered as a new official choice")
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify({ prerequisite: "Migration is triggered by a real extension-worker reload of saved disposable settings. SDK requests use only the local HTTP fixture.", legacy, migrated, custom, privateEndpoint, available, requests }, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, `${name}.png`) })
    }
    finally {
      if (ui && !ui.isClosed())
        await ui.close()
      await h.configure(previous)
    }
  })
}
