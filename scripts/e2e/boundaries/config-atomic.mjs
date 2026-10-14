import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

function observeConfigurationSaves() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_ATOMIC_CONFIG__ = { calls: [] }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const request = args.find(value => value && typeof value === "object" && value.type)
    const entry = { type: request?.type, settled: false, capacity: request?.data?.capacity ?? request?.data?.patch?.translate?.requestQueueConfig?.capacity }
    state.calls.push(entry)
    const record = (reply) => {
      entry.settled = true
      entry.error = reply?.err?.message
      entry.savedCapacity = reply?.res?.translate?.requestQueueConfig?.capacity
      return reply
    }
    if (typeof args.at(-1) === "function") {
      const callback = args.at(-1)
      const forwarded = [...args]
      forwarded[forwarded.length - 1] = reply => callback(record(reply))
      return send(...forwarded)
    }
    return send(...args).then(record, (error) => {
      entry.settled = true
      entry.error = error.message
      throw error
    })
  }
}

export async function runConfigAtomicCases(h) {
  await h.check("settings-configuration-metadata-failure-is-atomic-and-recovers", async () => {
    const name = "settings-configuration-metadata-failure-is-atomic-and-recovers"
    const label = "atomic-config-metadata-read"
    await h.prepareHost(name, "<p>Configuration and metadata must commit together when a reader saves actual request settings.</p>")
    await h.configure({ uiLocale: "en" })
    const worker = await h.extensionWorker()
    await worker.evaluate(h.installStorageBoundary)
    const readStored = () => worker.evaluate(async () => globalThis.chrome.storage.local.get(["config", "config$"]))
    const before = await readStored()
    const failedValue = before.config.translate.requestQueueConfig.capacity + 1
    const recoveredValue = failedValue + 1
    const ui = await h.context.newPage()
    await ui.addInitScript(h.installStorageBoundary)
    await ui.addInitScript(observeConfigurationSaves)
    try {
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await ui.bringToFront()
      const input = ui.locator("#translate-capacity")
      await h.until(() => input.isVisible(), "the actual options request-capacity control is mounted")
      await h.until(() => ui.evaluate(() => {
        const reads = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return reads.length >= 2 && reads.every(call => call.settled)
      }), "real settings bootstrap and hydration finish before the save fault")

      // Locked @wxt-dev/storage 1.2.8 stores local:config metadata as config$:
      // getMetaKey(key) returns `${key}$`. Fault only the real worker's native
      // metadata read; the options UI and primary configuration APIs stay real.
      await worker.evaluate((value) => {
        globalThis.__E2E_NATIVE_STORAGE__.plans.push({ area: "local", method: "get", key: "config$", action: "reject", label: value })
      }, label)
      await input.fill(String(failedValue))
      await h.until(() => worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.forwarded && call.settled), label), "the worker's real config$ read receives exactly the injected failure")
      await h.until(() => ui.evaluate(() => globalThis.__E2E_ATOMIC_CONFIG__.calls.some(call => call.type === "saveConfiguration" && call.settled && call.error)), "the real configuration actor rejects the metadata failure to its actual options caller")
      await h.until(async () => await ui.locator("[data-sonner-toast][data-type=error]").count() > 0, "the failed save gives visible feedback and leaves the options control usable")
      const failed = {
        stored: await readStored(),
        displayedCapacity: await input.inputValue(),
        messages: await ui.evaluate(() => globalThis.__E2E_ATOMIC_CONFIG__.calls),
        nativeCalls: await worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls),
      }
      await writeFile(path.join(h.outputPath, `${name}-failed-save.json`), JSON.stringify({ before, failed }, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, `${name}-failed-save.png`) })

      // Record the failed state first, then exercise a distinct actual save.
      // Both the negative snapshot and the successful retry are asserted below.
      await input.fill(String(recoveredValue))
      await h.until(() => ui.evaluate(value => globalThis.__E2E_ATOMIC_CONFIG__.calls.some(call => call.type === "saveConfiguration" && call.settled && !call.error && call.savedCapacity === value), recoveredValue), "the next independent configuration save receives an actual success reply")
      const recovered = {
        stored: await readStored(),
        displayedCapacity: await input.inputValue(),
        messages: await ui.evaluate(() => globalThis.__E2E_ATOMIC_CONFIG__.calls),
        nativeCalls: await worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls),
      }
      await writeFile(path.join(h.outputPath, `${name}-recovered-save.json`), JSON.stringify({ before, failed, recovered, injection: "One real native worker local.get config$ reply fails after being forwarded. Configuration writes, options input, messaging and metadata writes are unmodified." }, null, 2))
      await ui.screenshot({ path: path.join(h.outputPath, `${name}-recovered-save.png`) })
      assert.equal(failed.nativeCalls.filter(call => call.label === label).length, 1, "the fault is consumed by exactly one worker metadata read")
      assert.equal(failed.messages.filter(call => call.type === "setTranslateRequestQueueConfig").length, 0, "a rejected save must not apply an unconfirmed live-queue setting")
      assert.equal(recovered.stored.config.translate.requestQueueConfig.capacity, recoveredValue)
      assert.equal(recovered.displayedCapacity, String(recoveredValue), "the same options control remains usable after failure")
      assert.notDeepEqual(recovered.stored.config$, before.config$, "the successful independent save must update actual WXT metadata")
      assert.ok(recovered.stored.config$.lastModifiedAt > before.config$.lastModifiedAt, "successful metadata must contain a new native commit timestamp")
      assert.deepEqual(failed.stored.config, before.config, "a metadata failure must leave the actual primary configuration unchanged")
      assert.deepEqual(failed.stored.config$, before.config$, "a metadata failure must leave the actual metadata unchanged")
    }
    finally {
      await worker.evaluate((value) => {
        globalThis.__E2E_NATIVE_STORAGE__.plans = globalThis.__E2E_NATIVE_STORAGE__.plans.filter(plan => plan.label !== value)
      }, label)
      if (!ui.isClosed())
        await ui.close()
      await worker.evaluate(value => globalThis.chrome.storage.local.set(value), before)
      await h.publicMessage("setTranslateRequestQueueConfig", before.config.translate.requestQueueConfig)
    }
  })
}
