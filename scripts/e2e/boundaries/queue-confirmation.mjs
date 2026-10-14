import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

function observeQueueSettingReplies() {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_QUEUE_SETTING__ = { holdNextSave: false, held: [], calls: [] }
  state.release = () => {
    for (const release of state.held.splice(0))
      release()
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value?.type)
    if (!["saveConfiguration", "setTranslateBatchQueueConfig", "setTranslateRequestQueueConfig"].includes(message?.type))
      return send(...args)
    const hold = message.type === "saveConfiguration" && state.holdNextSave
    if (hold)
      state.holdNextSave = false
    const call = {
      type: message.type,
      data: message.type === "saveConfiguration" ? message.data.patch.translate : message.data,
      forwardedAtMs: performance.now(), nativeReplied: false, delivered: false,
    }
    state.calls.push(call)
    return send(...args).then((reply) => {
      call.nativeReplied = true
      call.nativeSuccess = reply != null && reply.err == null
      call.error = reply?.err?.message
      if (message.type === "saveConfiguration")
        call.savedBatch = reply?.res?.translate?.batchQueueConfig
      const deliver = () => {
        call.delivered = true
        return reply
      }
      return hold ? new Promise(resolve => state.held.push(() => resolve(deliver()))) : deliver()
    }, (error) => {
      call.nativeReplied = true
      call.delivered = true
      call.error = error.message
      throw error
    })
  }
}

// Keep the real page shortcut and its six enqueue messages. Only their native
// forwarding is synchronized, so a slow content preflight cannot create a
// false batch-size failure at the queue's 100 ms collection window.
function collectNativeTranslationBurst(markers) {
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  const state = globalThis.__E2E_QUEUE_BURST__ = { calls: [], held: [], collecting: true }
  state.release = () => {
    state.collecting = false
    for (const forward of state.held.splice(0))
      forward()
  }
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value?.type)
    if (message?.type !== "enqueueTranslateRequest" || !markers.some(marker => message.data.text.includes(marker)))
      return send(...args)
    const provider = { ...message.data.providerConfig }
    delete provider.apiKey
    const call = {
      message: { ...message, data: { ...message.data, providerConfig: provider } },
      collectedAtMs: performance.now(), forwarded: false, nativeReplied: false,
    }
    state.calls.push(call)
    const forward = () => {
      call.forwarded = true
      call.forwardedAtMs = performance.now()
      return send(...args).then((reply) => {
        call.nativeReplied = true
        call.result = reply?.res
        call.error = reply?.err?.message
        return reply
      }, (error) => {
        call.nativeReplied = true
        call.error = error.message
        throw error
      })
    }
    return state.collecting
      ? new Promise((resolve, reject) => state.held.push(() => forward().then(resolve, reject)))
      : forward()
  }
}

export async function runQueueConfirmationCases(h) {
  const name = "settings-old-batch-save-ack-preserves-newer-live-queue"
  await h.check(name, async () => {
    const worker = await h.extensionWorker()
    const read = () => worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    const before = await read()
    const pages = []
    const evidence = {
      boundary: "Both settings documents use genuine native save and queue replies. Document A's successful save reply is held only after persistence. Real Alt+E shortcuts collect six original content enqueue messages, then forward them together without altering any request or reply. Queue internals are not inspected. Provider credentials are omitted from recorded request parameters.",
      expected: "Document B persists and applies maxItemsPerBatch=3. Both before and after releasing document A's older maxItemsPerBatch=2 reply, six fresh paragraphs must produce at least one real three-item HTTP batch and no batch above three items, with every paragraph translated exactly once.",
      rounds: [],
    }
    let oldDocument
    let newDocument

    async function openOptions() {
      const ui = await h.context.newPage()
      pages.push(ui)
      await ui.addInitScript(h.installStorageBoundary)
      await ui.addInitScript(observeQueueSettingReplies)
      await ui.goto(`chrome-extension://${h.extensionId}/options.html#/translation`)
      await ui.bringToFront()
      await h.until(() => ui.locator("#batch-maxItemsPerBatch").isVisible(), "the real batch settings control is mounted")
      await h.until(() => ui.evaluate(() => {
        const calls = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
        return calls.length >= 2 && calls.every(call => call.forwarded && call.settled)
      }), "native options bootstrap and configuration hydration complete")
      return ui
    }

    async function observeDocument(ui) {
      return {
        displayedBatchSize: await ui.locator("#batch-maxItemsPerBatch").inputValue(),
        calls: await ui.evaluate(() => globalThis.__E2E_QUEUE_SETTING__.calls),
      }
    }

    async function translationRound(phase) {
      const markers = Array.from({ length: 6 }, (_, index) => `QUEUE_ACK_${phase.toUpperCase()}_${index + 1}`)
      const texts = markers.map(marker => `${marker} This fresh paragraph must be translated using the latest confirmed batch settings after concurrent editors have saved their choices.`)
      const round = { phase, markers, requests: [] }
      evidence.rounds.push(round)
      await h.prepareHost(`${name}-${phase}`, texts.map((text, index) => `<p id="queue-paragraph-${index + 1}">${text}</p>`).join(""))
      await h.page.evaluate(() => {
        document.querySelector("h1").classList.add("notranslate")
        document.title = ""
      })
      await h.inContentWorld(`(${collectNativeTranslationBurst.toString()})(${JSON.stringify(markers)})`)
      const requestStart = h.requests.length
      await h.page.bringToFront()
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(() => h.inContentWorld("globalThis.__E2E_QUEUE_BURST__.held.length === 6"), "the real page shortcut reached six native enqueue messages")
      const pending = await h.inContentWorld("globalThis.__E2E_QUEUE_BURST__.calls")
      assert.equal(pending.length, 6, "the user shortcut must create exactly six fresh source requests")
      assert.ok(pending.every(call => !call.forwarded), "no selected enqueue may escape the burst boundary early")
      await h.inContentWorld("globalThis.__E2E_QUEUE_BURST__.release()")
      await h.until(() => h.inContentWorld("globalThis.__E2E_QUEUE_BURST__.calls.every(call => call.nativeReplied)"), "all six genuine background queue replies complete")
      await h.until(async () => (await Promise.all(texts.map(text => h.hasTranslation(h.page, text)))).every(Boolean), "all six paragraphs receive their real local-provider translations")
      round.messages = await h.inContentWorld("globalThis.__E2E_QUEUE_BURST__.calls")
      round.requests = h.requests.slice(requestStart).filter(request => request.kind === "translation" && markers.some(marker => request.input.includes(marker)))
      round.batches = round.requests.map(request => markers.filter(marker => request.input.includes(marker)))
      round.batchSizes = round.batches.map(batch => batch.length)
      round.dom = await h.page.locator("#article").textContent()
      round.errorControls = await h.page.locator(".vibe-reading-translation-error-container").count()
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}-${phase}.png`) })
      assert.ok(round.requests.every(request => request.status === 200), "the provider calibration must have no HTTP failure or retry")
      assert.ok(markers.every(marker => round.batches.flat().filter(value => value === marker).length === 1), "each fresh source must reach exactly one provider input, without a cache hit")
      assert.equal(round.errorControls, 0, "a queue update must leave no paragraph error controls")
      return round
    }

    try {
      await h.configure({ uiLocale: "en", translate: { batchQueueConfig: { maxItemsPerBatch: 1, maxCharactersPerBatch: 100000 }, requestQueueConfig: { capacity: 100, rate: 100 } } })
      await h.publicMessage("setTranslateRequestQueueConfig", { capacity: 100, rate: 100 })
      await h.publicMessage("setTranslateBatchQueueConfig", { maxItemsPerBatch: 1, maxCharactersPerBatch: 100000 })
      oldDocument = await openOptions()
      await oldDocument.evaluate(() => {
        globalThis.__E2E_QUEUE_SETTING__.holdNextSave = true
      })
      await oldDocument.locator("#batch-maxItemsPerBatch").fill("2")
      await h.until(() => oldDocument.evaluate(() => globalThis.__E2E_QUEUE_SETTING__.held.length === 1), "document A's genuine successful save reply waits after its native commit")
      evidence.oldSave = await observeDocument(oldDocument)
      assert.equal((await read()).translate.batchQueueConfig.maxItemsPerBatch, 2, "document A must really persist two before its reply is delayed")
      assert.equal(evidence.oldSave.calls[0].nativeSuccess, true, "the delayed reply must be a genuine successful background save")
      assert.equal(evidence.oldSave.calls[0].savedBatch.maxItemsPerBatch, 2, "the held native acknowledgement must confirm A's own two-item save")
      assert.equal(evidence.oldSave.calls[0].delivered, false, "document A must not have received its save acknowledgement")
      assert.equal(evidence.oldSave.calls.filter(call => call.type === "setTranslateBatchQueueConfig").length, 0, "a committed save must not need a separate document-local queue message before receiving its reply")
      newDocument = await openOptions()
      await newDocument.locator("#batch-maxItemsPerBatch").fill("3")
      await h.until(() => newDocument.evaluate(() => globalThis.__E2E_QUEUE_SETTING__.calls.some(call => call.type === "saveConfiguration" && call.savedBatch?.maxItemsPerBatch === 3 && call.nativeSuccess && call.delivered)), "document B's actual save acknowledges the newer committed batch size")
      assert.equal((await read()).translate.batchQueueConfig.maxItemsPerBatch, 3, "document B must persist the newer batch size before releasing A")
      evidence.newSave = await observeDocument(newDocument)
      const calibration = await translationRound("before-old-ack")
      assert.ok(calibration.batchSizes.includes(3) && calibration.batchSizes.every(size => size <= 3), "the real queue must first prove that the six-message burst can form batches of three")
      evidence.calibrationConfirmed = true
      await oldDocument.evaluate(async () => {
        globalThis.__E2E_QUEUE_SETTING__.release()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await h.until(() => oldDocument.evaluate(() => globalThis.__E2E_QUEUE_SETTING__.calls.every(call => call.nativeReplied && call.delivered)), "the old save and any resulting live-queue message are fully acknowledged")
      await h.until(async () => await oldDocument.locator("#batch-maxItemsPerBatch").inputValue() === "3" && await newDocument.locator("#batch-maxItemsPerBatch").inputValue() === "3", "both real settings documents retain the newer confirmed value")
      evidence.afterOldReply = { oldDocument: await observeDocument(oldDocument), newDocument: await observeDocument(newDocument), savedBatch: (await read()).translate.batchQueueConfig }
      assert.equal(evidence.afterOldReply.savedBatch.maxItemsPerBatch, 3, "the older successful reply must not change the newer persisted setting")
      const after = await translationRound("after-old-ack")
      assert.ok(after.batchSizes.includes(3) && after.batchSizes.every(size => size <= 3), `releasing the older reply must preserve the latest live batch size of three; observed HTTP batch sizes: ${after.batchSizes.join(", ")}`)
    }
    finally {
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      await h.inContentWorld("globalThis.__E2E_QUEUE_BURST__?.release()")
      if (oldDocument && !oldDocument.isClosed()) {
        await oldDocument.evaluate(async () => {
          globalThis.__E2E_QUEUE_SETTING__.release()
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        await h.until(() => oldDocument.evaluate(() => globalThis.__E2E_QUEUE_SETTING__.calls.every(call => call.nativeReplied && call.delivered)), "the held settings boundary completes before cleanup")
      }
      for (const ui of pages) {
        if (!ui.isClosed())
          await ui.close()
      }
      await h.configure(before)
      await h.publicMessage("setTranslateRequestQueueConfig", before.translate.requestQueueConfig)
      await h.publicMessage("setTranslateBatchQueueConfig", before.translate.batchQueueConfig)
    }
  })
}
