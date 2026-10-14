import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { delayNativeConfigCommit, holdConfigSubmission, releaseConfigSubmission, submissionHeld } from "./config-concurrency.mjs"
import { installConfigurationSaveReadFault, removeConfigurationSaveReadFault, waitForConfigurationSaveReadFault } from "./settings.mjs"

function observeOwnerSaveMessages() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_PENDING_OWNER__ = { document: globalThis.crypto.randomUUID(), calls: [] }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value?.type)
    if (message?.type !== "saveConfiguration")
      return send(...args)
    const call = {
      id: message.id,
      type: message.type,
      label: globalThis.__E2E_CONFIG_COMMITS__.label,
      patchKeys: Object.keys(message.data.patch),
      requestQueuePatch: message.data.patch.translate?.requestQueueConfig,
      replied: false,
    }
    state.calls.push(call)
    return send(...args).then((reply) => {
      call.replied = true
      call.error = reply?.err?.message
      call.savedRequestQueue = reply?.res?.translate?.requestQueueConfig
      return reply
    }, (error) => {
      call.replied = true
      call.error = error.message
      throw error
    })
  }
}

export async function runPendingOwnerCases(h) {
  const name = "settings-repeated-reset-awaits-pending-owner-at-confirmed-value"
  await h.check(name, async () => {
    const worker = await h.extensionWorker()
    const read = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const before = await read()
    const labels = ["pending-owner-rate", "pending-owner-capacity", "pending-owner-reset"]
    const faultLabel = "pending-owner-reset-save-read"
    let ui
    const evidence = {
      boundary: "The real options document submits its own unchanged public save messages. The shared native-message boundary holds W1 before forwarding, then W2 and W3 in submission order. All message replies come from the loaded extension. Only W3's real background configuration read receives a one-shot failure. Configuration atoms and queue internals are not inspected.",
      expected: "A second Reset must await the pending rate restoration even though its value equals the older confirmed value. The dialog stays open while that Reset waits and when its genuine save fails. A deliberate retry closes only after the defaults are persisted.",
      phases: [],
    }
    const ready = async (selector) => {
      await h.until(() => ui.locator(selector).isVisible(), "the real options route is mounted")
      await h.until(() => ui.evaluate(() => {
        const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return reads.length >= 2 && reads.every(call => call.forwarded && call.settled)
      }), "real options bootstrap and configuration hydration are complete")
    }
    const reset = () => ui.locator("#reset-config").getByRole("button", { name: "Reset Config", exact: true })
    const dialog = () => ui.getByRole("alertdialog")
    const confirm = () => dialog().getByRole("button", { name: "Confirm", exact: true })
    const record = async (phase, extra = {}) => {
      evidence.phases.push({
        phase,
        storedRequestQueue: (await read()).translate.requestQueueConfig,
        dialogCount: await dialog().count(),
        errorToasts: await ui.locator("[data-sonner-toast][data-type=error]").allTextContents(),
        native: await ui.evaluate(() => ({
          messages: globalThis.__E2E_PENDING_OWNER__.calls,
          commits: globalThis.__E2E_CONFIG_COMMITS__.calls,
          held: globalThis.__E2E_CONFIG_COMMITS__.held.map(entry => ({ label: entry.label })),
          storage: globalThis.__E2E_NATIVE_STORAGE__.calls,
        })),
        ...extra,
      })
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, `${name}-${phase}.png`) })
    }

    try {
      await h.configure({ uiLocale: "en" })
      ui = await h.context.newPage()
      await ui.addInitScript(h.installStorageBoundary)
      await ui.addInitScript(delayNativeConfigCommit)
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/config`)
      await ui.bringToFront()
      await ready("#reset-config")
      // Install this observer after the shared delay boundary, preserving its
      // actual forwarding and replies while recording each public invocation.
      await ui.evaluate(observeOwnerSaveMessages)
      evidence.version = await ui.evaluate(() => globalThis.chrome.runtime.getManifest().version)
      const document = await ui.evaluate(() => globalThis.__E2E_PENDING_OWNER__.document)
      await reset().click()
      await confirm().click()
      await h.until(async () => await dialog().count() === 0, "an actual initial Reset has saved the defaults")
      const defaults = await read()
      const defaultQueue = defaults.translate.requestQueueConfig
      const fixtureQueue = { ...defaultQueue, capacity: defaultQueue.capacity + 10 }
      const editedRate = defaultQueue.rate + 1
      evidence.defaultRequestQueue = defaultQueue
      evidence.fixtureRequestQueue = fixtureQueue
      await h.configure({ translate: { requestQueueConfig: fixtureQueue } })
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await ready("#translate-rate")
      assert.equal(await ui.evaluate(() => globalThis.__E2E_PENDING_OWNER__.document), document,
        "route changes must retain the same real options document and its pending save queue")
      await h.until(async () => await ui.locator("#translate-capacity").inputValue() === String(fixtureQueue.capacity)
        && await ui.locator("#translate-rate").inputValue() === String(defaultQueue.rate),
      "the actual queue controls display the confirmed fixture before editing")

      await holdConfigSubmission(ui, labels[0])
      await ui.locator("#translate-rate").fill(String(editedRate))
      const firstHeld = await submissionHeld(h, ui, labels[0])
      assert.deepEqual((await read()).translate.requestQueueConfig, fixtureQueue,
        "W1 must be held before any native commit or storage watch can confirm its edited rate")
      await holdConfigSubmission(ui, labels[1])
      await ui.locator("#translate-capacity").fill(String(defaultQueue.capacity))
      await h.until(async () => await ui.locator("#translate-capacity").inputValue() === String(defaultQueue.capacity),
        "W2 optimistically restores capacity while W1 remains unforwarded")
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/config`)
      await ready("#reset-config")
      assert.equal(await ui.evaluate(() => globalThis.__E2E_PENDING_OWNER__.document), document,
        "Reset must run in the same document that owns W1 and W2")
      await reset().click()
      await confirm().click()
      assert.equal(await dialog().count(), 1, "W3 cannot complete while the earlier real saves wait")
      await confirm().click()
      await record("repeated-reset-queued", { firstHeld, actions: ["W1 edit rate", "W2 restore capacity", "W3 Reset", "W4 repeat Reset"] })

      await releaseConfigSubmission(ui, labels[0])
      const secondHeld = await submissionHeld(h, ui, labels[1])
      assert.deepEqual((await read()).translate.requestQueueConfig, { ...fixtureQueue, rate: editedRate },
        "only W1 may have persisted while W2 is held before forwarding")
      await holdConfigSubmission(ui, labels[2])
      await releaseConfigSubmission(ui, labels[1])
      const resetHeld = await submissionHeld(h, ui, labels[2])
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const beforeFailedReset = await read()
      assert.deepEqual(beforeFailedReset.translate.requestQueueConfig, { ...defaultQueue, rate: editedRate },
        "W2 must persist capacity, while W3 has not restored the rate")
      const pendingDialogCount = await dialog().count()
      await record("reset-owner-held", { secondHeld, resetHeld, pendingDialogCount })

      // Finish failure and recovery even on the broken candidate, retaining the
      // earlier premature acknowledgement as the final acceptance assertion.
      await installConfigurationSaveReadFault(worker, h.installStorageBoundary, ui.url(), faultLabel)
      await releaseConfigSubmission(ui, labels[2])
      const fault = await waitForConfigurationSaveReadFault(worker, h.until, faultLabel)
      await h.until(() => ui.evaluate(value => globalThis.__E2E_PENDING_OWNER__.calls.some(call =>
        call.label === value && call.replied && call.error === "E2E storage boundary unavailable"), labels[2]),
      "W3 returns the genuine background save failure through its original public message")
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0,
        "the original failed Reset reports visible failure feedback")
      await ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.deepEqual(await read(), beforeFailedReset, "W3's rejected save must leave the real configuration unchanged")
      const failedDialogCount = await dialog().count()
      await record("reset-owner-failed", { fault, failedDialogCount, pendingDialogCount })

      const callsBeforeRetry = await ui.evaluate(() => globalThis.__E2E_PENDING_OWNER__.calls.length)
      if (failedDialogCount === 0)
        await reset().click()
      await confirm().click()
      await h.until(() => ui.evaluate(index => globalThis.__E2E_PENDING_OWNER__.calls.slice(index).some(call =>
        call.replied && !call.error), callsBeforeRetry), "a deliberate next Reset receives its real successful save reply")
      await h.until(async () => await dialog().count() === 0, "only the successful retry closes the actual Reset dialog")
      assert.deepEqual(await read(), defaults, "the deliberate retry must persist the defaults read from the initial actual Reset")
      await record("retry-recovered", { pendingDialogCount, failedDialogCount })
      assert.equal(pendingDialogCount, 1,
        "a repeated Reset must await the pending owner that restores rate to its older confirmed value")
      assert.equal(failedDialogCount, 1, "both Reset intents must remain unconfirmed after their shared pending owner fails")
    }
    finally {
      try {
        try {
          await removeConfigurationSaveReadFault(worker, faultLabel)
        }
        finally {
          if (ui && !ui.isClosed()) {
            try {
              if (await ui.evaluate(() => !!globalThis.__E2E_CONFIG_COMMITS__)) {
                await holdConfigSubmission(ui, null)
                for (const label of labels)
                  await releaseConfigSubmission(ui, label)
                await h.until(() => ui.evaluate(() => globalThis.__E2E_CONFIG_COMMITS__.calls.every(call => call.settled)
                  && (!globalThis.__E2E_PENDING_OWNER__ || globalThis.__E2E_PENDING_OWNER__.calls.every(call => call.replied))),
                "all owned real submissions and replies finish before restoring the fixture")
              }
            }
            finally {
              await ui.close()
            }
          }
        }
      }
      finally {
        await h.configure(before)
        await h.publicMessage("setTranslateRequestQueueConfig", before.translate.requestQueueConfig)
        await h.publicMessage("setTranslateBatchQueueConfig", before.translate.batchQueueConfig)
      }
    }
  })
}
