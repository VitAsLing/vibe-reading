import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"

// Playwright's CDPSession does not expose flattened child-session routing.
// Connect only to the disposable Chrome's own loopback debugging endpoint.
async function connectNativeProtocol(endpoint) {
  const url = new URL(endpoint)
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "acceptance CDP must remain on loopback")
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.ok, true, "the disposable Chrome debugging endpoint is available")
  const { webSocketDebuggerUrl } = await response.json()
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const listeners = new Map()
  const rejectPending = (sessionId) => {
    for (const [id, request] of pending) {
      if (sessionId && request.sessionId !== sessionId)
        continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.reject(new Error("Acceptance worker protocol closed"))
    }
  }
  socket.addEventListener("close", () => rejectPending())
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error)
        request.reject(new Error(`${request.method}: ${message.error.message}`))
      else
        request.resolve(message.result)
      return
    }
    for (const listener of listeners.get(message.method) ?? [])
      listener(message.params, message.sessionId)
  })
  const root = {
    send(method, params = {}, sessionId) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Acceptance CDP command timed out: ${method}`))
        }, 10000)
        pending.set(id, { resolve, reject, timer, sessionId, method })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    on(method, listener) {
      const callbacks = listeners.get(method) ?? new Set()
      callbacks.add(listener)
      listeners.set(method, callbacks)
    },
    off(method, listener) {
      listeners.get(method)?.delete(listener)
    },
    child(sessionId) {
      return {
        send: (method, params) => root.send(method, params, sessionId),
        dispose: () => rejectPending(sessionId),
      }
    },
    async detach() {
      rejectPending()
      socket.close()
    },
  }
  return root
}

function observeTranslationReplies() {
  const state = globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__ = []
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && typeof value.type === "string")
    const record = (response) => {
      if (message?.type === "enqueueTranslateRequest") {
        state.push({ text: message.data.text, error: response?.err?.message, received: true })
      }
      else if (message?.type === "saveConfiguration") {
        state.push({
          type: message.type,
          mode: message.data.patch?.translate?.mode,
          capacity: message.data.patch?.translate?.requestQueueConfig?.capacity,
          queueFields: Object.keys(message.data.patch?.translate ?? {}).filter(key => ["requestQueueConfig", "batchQueueConfig"].includes(key)),
          savedMode: response?.res?.translate?.mode,
          savedCapacity: response?.res?.translate?.requestQueueConfig?.capacity,
          error: response?.err?.message, received: true,
        })
      }
      return response
    }
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null
    if (callback) {
      const forwarded = [...args]
      forwarded[forwarded.length - 1] = (...values) => {
        record(values[0])
        return callback(...values)
      }
      return send(...forwarded)
    }
    return send(...args).then(record)
  }
}

function observeProviderSnapshots() {
  const snapshots = globalThis.__E2E_PROVIDER_SNAPSHOTS__ = []
  const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime)
  globalThis.chrome.runtime.sendMessage = (...args) => {
    const message = args.find(value => value && typeof value === "object" && value.type === "enqueueTranslateRequest")
    if (message) {
      snapshots.push({
        text: message.data.text, hash: message.data.hash,
        model: message.data.providerConfig.model.customModel,
        baseURL: message.data.providerConfig.baseURL,
      })
    }
    return send(...args)
  }
}

export async function runBackgroundRecoveryCases(h) {
  const { check, page, cdp, extensionId, prepareHost, until, nodeGesture,
    hasTranslation, inContentWorld, extensionWorker, installStorageBoundary,
    publicMessage, outputPath, requests, nativeBrowserEndpoint } = h

  for (const [suffix, key, queueSave] of [["config", "config"], ["metadata", "config$"], ["queue-readiness", "config$", true]]) {
    const name = queueSave ? "background-startup-queue-readiness-rejects-save-and-recovers" : `background-startup-${suffix}-read-failure-recovers`
    await check(name, async () => {
      const text = queueSave
        ? "A queue readiness failure during background startup must reject a settings save before persistence, then the next independent save and paragraph gesture must recover in the same worker."
        : `A one-time ${suffix} read failure during background wakeup must remain a visible error, then the reader's Retry must recover without restarting the extension worker.`
      await prepareHost(name, `<p id="background-retry-source">${text}</p>`)
      await inContentWorld(`(${observeTranslationReplies.toString()})()`)
      let settings
      let restoreStored
      let queueRecovered = false
      if (queueSave) {
        restoreStored = await (await extensionWorker()).evaluate(async () => globalThis.chrome.storage.local.get(["config", "config$"]))
        await h.configure({ uiLocale: "en" })
      }
      const versions = new Map()
      const versionEvents = []
      const updateVersions = ({ versions: updates }) => {
        for (const version of updates) {
          versions.set(version.versionId, version)
          versionEvents.push({ scriptURL: version.scriptURL, versionId: version.versionId, runningStatus: version.runningStatus })
        }
      }
      cdp.on("ServiceWorker.workerVersionUpdated", updateVersions)
      await cdp.send("ServiceWorker.disable")
      await cdp.send("ServiceWorker.enable")
      const workerURL = (await extensionWorker()).url()
      const currentVersion = () => [...versions.values()].find(version => version.scriptURL === workerURL && version.runningStatus === "running")
      await until(() => currentVersion(), "the actual extension worker version before cold storage failure")
      assert.ok(nativeBrowserEndpoint, "cold-worker acceptance requires the disposable native Chrome CDP endpoint")
      const root = await connectNativeProtocol(nativeBrowserEndpoint)
      const protocols = []
      const workerProtocols = new Map()
      const setupTasks = []
      const evidence = { boundary: "Real Chrome storage.local.get is forwarded, then exactly one completed native result is rejected before production background initialization finishes", key, events: [] }
      let injected = false
      let resolveReady
      let rejectReady
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      // A failed hook is still surfaced by awaiting ready after the user gesture.
      void ready.catch(() => {})
      const installFault = async (child, callFrameId) => {
        if (!injected) {
          const expression = `(${installStorageBoundary.toString()})(); globalThis.__E2E_NATIVE_STORAGE__.plans.push(${JSON.stringify({ area: "local", method: "get", key, action: "reject", label: name })}); globalThis.chrome.runtime.id`
          const result = callFrameId
            ? await child.send("Debugger.evaluateOnCallFrame", { callFrameId, expression, returnByValue: true })
            : await child.send("Runtime.evaluate", { expression, returnByValue: true })
          if (result.exceptionDetails)
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
          assert.equal(result.result.value, extensionId, "the boundary must be installed in the real extension worker before initialization")
          injected = true
        }
      }
      const attached = (event) => {
        evidence.events.push({ phase: "native-target-attached", type: event.targetInfo.type, url: event.targetInfo.url, waitingForDebugger: event.waitingForDebugger })
        if (event.targetInfo.type !== "service_worker" || event.targetInfo.url !== workerURL)
          return
        const child = root.child(event.sessionId)
        protocols.push(child)
        workerProtocols.set(event.sessionId, child)
        const task = (async () => {
          if (event.waitingForDebugger) {
            evidence.events.push({ phase: "cold-worker-paused-before-entrypoint", targetId: event.targetInfo.targetId, waitingForDebugger: true })
            await child.send("Runtime.enable")
            await installFault(child)
            await child.send("Runtime.runIfWaitingForDebugger")
            resolveReady()
          }
          else if (!injected) {
            // Chrome keeps this target attached across ServiceWorker.stopWorker.
            // Its debugger instrumentation persists for the next script execution.
            await child.send("Debugger.enable")
            const { breakpointId } = await child.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" })
            child.breakpointId = breakpointId
            evidence.events.push({ phase: "existing-worker-next-script-pause-armed", targetId: event.targetInfo.targetId })
          }
        })()
        setupTasks.push(task)
        void task.catch(rejectReady)
      }
      const paused = (event, sessionId) => {
        const child = workerProtocols.get(sessionId)
        if (!child)
          return
        const task = (async () => {
          evidence.events.push({ phase: "cold-worker-script-paused", reason: event.reason, url: event.callFrames[0]?.url })
          if (child.breakpointId) {
            await child.send("Debugger.removeBreakpoint", { breakpointId: child.breakpointId })
            child.breakpointId = undefined
          }
          await installFault(child, event.callFrames[0]?.callFrameId)
          await child.send("Debugger.resume")
          resolveReady()
        })()
        setupTasks.push(task)
        void task.catch(rejectReady)
      }
      root.on("Target.attachedToTarget", attached)
      root.on("Debugger.paused", paused)
      try {
        await root.send("Target.setDiscoverTargets", { discover: true })
        await root.send("Target.setAutoAttach", {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          filter: [{ type: "service_worker", exclude: false }],
        })
        await until(() => evidence.events.some(event => event.phase === "existing-worker-next-script-pause-armed"), "actual worker debugger armed for cold entrypoint")
        const oldVersion = currentVersion()
        evidence.events.push({ phase: "native-worker-stop-requested", versionId: oldVersion.versionId })
        await cdp.send("ServiceWorker.stopWorker", { versionId: oldVersion.versionId })
        await until(() => versions.get(oldVersion.versionId)?.runningStatus === "stopped", "worker actually stopped before the public wakeup entry")
        const requestStart = requests.length
        let fetchWakeup
        if (queueSave) {
          fetchWakeup = publicMessage("backgroundFetch", { url: `${h.origin}/audit-${name}-wakeup`, method: "GET", credentials: "omit" })
          // Wait for the shared pre-entrypoint hook before awaiting its reply.
          void fetchWakeup.catch(() => {})
        }
        else {
          await nodeGesture(page, "#background-retry-source")
        }
        await Promise.race([ready, new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("New cold worker did not expose a pre-entrypoint storage boundary")), 10000)
          void ready.finally(() => clearTimeout(timer)).catch(() => {})
        })])
        if (queueSave) {
          const response = await fetchWakeup
          assert.equal(response.status, 200, "a genuine non-queue background fetch must wake the worker successfully")
          evidence.wakeup = { type: "backgroundFetch", method: "GET", status: response.status }
        }
        if (!queueSave)
          await until(async () => await page.locator("#background-retry-source .vibe-reading-translation-error-container").count() === 1, "one-time background initialization failure has real paragraph Retry controls")
        const worker = await extensionWorker()
        const readBoundary = () => worker.evaluate(() => ({
          calls: globalThis.__E2E_NATIVE_STORAGE__.calls,
          plans: globalThis.__E2E_NATIVE_STORAGE__.plans,
          held: globalThis.__E2E_NATIVE_STORAGE__.held.map(entry => ({ label: entry.label })),
        }))
        await until(() => worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.calls.some(call => call.label === value && call.settled), name), "the single native startup storage fault has completed")
        evidence.afterFailure = await readBoundary()
        assert.equal(evidence.afterFailure.calls.filter(call => call.label === name && call.forwarded && call.settled).length, 1, "exactly one real initialization read must fail at the native reply boundary")
        assert.equal(evidence.afterFailure.plans.length, 0, "the one-shot external fault is already withdrawn before Retry")
        if (queueSave) {
          await until(() => currentVersion(), "the fetched worker is running before the settings recovery flow")
          const recoveredVersionId = currentVersion().versionId
          const recoveryEventsStart = versionEvents.length
          const readStored = () => worker.evaluate(async () => globalThis.chrome.storage.local.get(["config", "config$"]))
          settings = await h.context.newPage()
          await settings.addInitScript(installStorageBoundary)
          await settings.addInitScript(observeTranslationReplies)
          await settings.goto(`chrome-extension://${extensionId}/options.html#/translation`)
          await settings.bringToFront()
          const input = settings.locator("#translate-capacity")
          await until(() => input.isVisible(), "the real options request-capacity control is mounted")
          await until(() => settings.evaluate(() => {
            const calls = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.keys.includes("config"))
            return calls.length >= 2 && calls.every(call => call.forwarded && call.settled)
          }), "native options bootstrap and hydration finish before the settings gesture")
          const initial = await readStored()
          const nextMode = initial.config.translate.mode === "translationOnly" ? "bilingual" : "translationOnly"
          await settings.locator("#translation-mode").getByRole("combobox").click()
          await settings.getByRole("option", { name: nextMode === "translationOnly" ? "Translation Only" : "Bilingual", exact: true }).click()
          await until(() => settings.evaluate(value => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__.some(reply => reply.type === "saveConfiguration" && reply.mode === value && reply.savedMode === value && !reply.error), nextMode), "a real non-queue mode save recovers configuration initialization")
          // The initialization retry can repair metadata. Capture only after
          // the real mode save succeeds, isolating queue readiness atomicity.
          evidence.beforeQueueSave = await readStored()
          evidence.modeRecoveryReplies = await settings.evaluate(() => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__)
          assert.deepEqual(evidence.modeRecoveryReplies.find(reply => reply.mode === nextMode).queueFields, [], "the recovery mode save must not request any queue change")
          assert.equal(evidence.beforeQueueSave.config.translate.mode, nextMode, "configuration initialization must already be healthy before the queue save")
          const failedCapacity = evidence.beforeQueueSave.config.translate.requestQueueConfig.capacity + 1
          const recoveredCapacity = failedCapacity + 1
          await input.fill(String(failedCapacity))
          await until(() => settings.evaluate(value => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__.some(reply => reply.type === "saveConfiguration" && reply.capacity === value && reply.error), failedCapacity), "the actual queue setting save receives the original rejected startup cohort")
          await until(async () => await settings.locator("[data-sonner-toast][data-type=error]").count() > 0, "failed queue readiness gives visible settings feedback")
          await until(async () => await input.inputValue() === String(evidence.beforeQueueSave.config.translate.requestQueueConfig.capacity), "the failed queue setting rolls back to its real confirmed value")
          evidence.failedQueueSave = {
            stored: await readStored(), displayedCapacity: await input.inputValue(),
            replies: await settings.evaluate(() => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__),
            nativeCalls: (await readBoundary()).calls,
          }
          await settings.screenshot({ path: path.join(outputPath, `${name}-failed-save.png`) })
          const failedReply = evidence.failedQueueSave.replies.find(reply => reply.capacity === failedCapacity)
          assert.equal(failedReply.error, "E2E storage boundary unavailable", "the first queue save must expose the original startup storage failure unchanged")
          assert.deepEqual(evidence.failedQueueSave.stored.config, evidence.beforeQueueSave.config, "queue readiness failure must leave primary configuration unchanged")
          assert.deepEqual(evidence.failedQueueSave.stored.config$, evidence.beforeQueueSave.config$, "queue readiness failure must leave metadata unchanged")
          assert.equal(requests.slice(requestStart).filter(request => request.kind === "translation" && request.input.includes(text)).length, 0, "neither the fetch wakeup nor the failed settings save may translate the source")
          await input.fill(String(recoveredCapacity))
          await until(() => settings.evaluate(value => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__.some(reply => reply.type === "saveConfiguration" && reply.capacity === value && reply.savedCapacity === value && !reply.error), recoveredCapacity), "the next independent queue save obtains a genuine success reply")
          queueRecovered = true
          evidence.recoveredQueueSave = {
            stored: await readStored(), displayedCapacity: await input.inputValue(),
            replies: await settings.evaluate(() => globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__),
            nativeCalls: (await readBoundary()).calls,
          }
          assert.equal(evidence.recoveredQueueSave.stored.config.translate.requestQueueConfig.capacity, recoveredCapacity, "the independent save must persist its actual new capacity")
          assert.equal(evidence.recoveredQueueSave.displayedCapacity, String(recoveredCapacity), "the same settings control remains usable after readiness failure")
          assert.ok(evidence.recoveredQueueSave.stored.config$.lastModifiedAt > evidence.beforeQueueSave.config$.lastModifiedAt, "the successful independent queue save must advance actual metadata")
          await nodeGesture(page, "#background-retry-source")
          await until(() => hasTranslation(page, text), "a real paragraph gesture translates after the same-worker settings recovery")
          evidence.recoveredHTTP = requests.slice(requestStart).filter(request => request.kind === "translation" && request.input.includes(text))
          assert.equal(evidence.recoveredHTTP.length, 1, "the recovery gesture must reach the actual provider exactly once")
          assert.equal(evidence.recoveredHTTP[0].status, 200, "the recovery must produce a successful actual HTTP translation")
          assert.equal(currentVersion()?.versionId, recoveredVersionId, "settings and paragraph recovery must retain the same worker version")
          assert.equal(versionEvents.slice(recoveryEventsStart).some(version => version.scriptURL === workerURL && version.runningStatus !== "running"), false, "the worker must not stop or restart during settings and gesture recovery")
          await page.screenshot({ path: path.join(outputPath, `${name}-recovered.png`) })
          return
        }
        assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false, "failed initialization must not manufacture an enabled page session")
        assert.equal(requests.slice(requestStart).filter(request => request.kind === "translation" && request.input.includes(text)).length, 0, "failed initialization must not contact the provider")
        await page.screenshot({ path: path.join(outputPath, `${name}-first-error.png`) })
        await page.locator("#background-retry-source .vibe-reading-translation-error-container button").first().click()
        await until(async () => await inContentWorld(`globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__.filter(entry => entry.text === ${JSON.stringify(text)}).length >= 2`), "real paragraph Retry has received its second background reply")
        evidence.repliesAfterRetry = await inContentWorld("globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__")
        evidence.afterRetry = await readBoundary()
        const replies = evidence.repliesAfterRetry.filter(entry => entry.text === text)
        assert.equal(replies[0].error, "E2E storage boundary unavailable", "the first real storage failure must reach the reader unchanged")
        // A restart control diagnoses permanent worker poisoning but does not
        // weaken the acceptance requirement that the second attempt succeeds.
        if (replies[1].error) {
          await until(() => currentVersion(), "failed worker is still running before the restart control")
          const failedVersion = currentVersion()
          await cdp.send("ServiceWorker.stopWorker", { versionId: failedVersion.versionId })
          await until(() => versions.get(failedVersion.versionId)?.runningStatus === "stopped", "restart control stopped the failed worker")
          await until(async () => await page.locator("#background-retry-source .vibe-reading-translation-error-container button").count() === 1, "second error remains recoverable through its visible Retry button")
          await page.locator("#background-retry-source .vibe-reading-translation-error-container button").click()
          await until(() => hasTranslation(page, text), "a new native worker recovers with no storage fault")
          evidence.restartControlRecovered = true
        }
        assert.equal(replies[1].error, undefined, "with the one-shot initialization fault removed, Retry must succeed in the same worker")
        await until(() => hasTranslation(page, text), "reader Retry completes the current paragraph without restarting the worker")
        assert.equal(await inContentWorld("globalThis.chrome.runtime.id"), extensionId, "the original content script remains live throughout failure and recovery")
        await page.screenshot({ path: path.join(outputPath, `${name}-recovered.png`) })
      }
      finally {
        evidence.finalReplies = await inContentWorld("globalThis.__E2E_BACKGROUND_RECOVERY_REPLIES__").catch(error => ({ unavailable: error.message }))
        evidence.workerVersionTransitions = versionEvents.filter(version => version.scriptURL === workerURL)
        await writeFile(path.join(outputPath, `${name}.json`), JSON.stringify(evidence, (key, value) => key === "apiKey" ? undefined : value, 2))
        if (settings && !settings.isClosed())
          await settings.close()
        if (restoreStored) {
          await (await extensionWorker()).evaluate(value => globalThis.chrome.storage.local.set(value), restoreStored)
          if (queueRecovered) {
            await publicMessage("setTranslateRequestQueueConfig", restoreStored.config.translate.requestQueueConfig)
            await publicMessage("setTranslateBatchQueueConfig", restoreStored.config.translate.batchQueueConfig)
          }
        }
        await root.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
        root.off("Target.attachedToTarget", attached)
        root.off("Debugger.paused", paused)
        for (const protocol of protocols)
          protocol.dispose()
        await Promise.allSettled(setupTasks)
        await root.detach()
        cdp.off("ServiceWorker.workerVersionUpdated", updateVersions)
      }
    })
  }

  await check("background-queued-provider-snapshot-preserves-cache-identity", async () => {
    const name = "background-queued-provider-snapshot-preserves-cache-identity"
    const target = "A queued paragraph must use its original provider model and endpoint so that a later configuration change cannot poison its original cache identity."
    const freshB = "A new paragraph after saving provider B must use the newly selected provider without changing the earlier request's configuration snapshot."
    const records = []
    const held = []
    const server = http.createServer((req, res) => {
      void (async () => {
        let body = ""
        for await (const chunk of req)
          body += chunk
        const payload = JSON.parse(body)
        const input = payload.messages.find(message => message.role === "user")?.content ?? ""
        const system = payload.messages.find(message => message.role === "system")?.content ?? ""
        const detection = system.includes("language detection assistant")
        const marker = req.url.startsWith("/a/") ? "snapshot-A" : "snapshot-B"
        const template = system.includes("SNAPSHOT_TEMPLATE_A") ? "template-A" : "template-B"
        const record = { route: req.url, model: payload.model, system, input, kind: detection ? "language" : "translation", marker, template }
        records.push(record)
        const reply = () => {
          record.replied = true
          if (res.destroyed)
            return
          const text = detection
            ? JSON.stringify({ code: "eng" })
            : input.replace(/^Translate to [^:]+:\s*/, "").replace(/^\[SNAPSHOT_USER_[AB]\]\s*/, "").split(/\n\s*%%\s*\n/).map(part => `[E2E translated] ${part.trim()} [provider ${marker}] [${template}]`).join("\n%%\n")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            id: "local-provider-snapshot", object: "chat.completion", created: 1, model: payload.model,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
          }))
        }
        if (!detection && input.includes("Provider snapshot token blocker one")) {
          record.held = true
          held.push(reply)
        }
        else {
          reply()
        }
      })().catch((error) => {
        records.push({ fixtureError: error.message })
        if (!res.headersSent)
          res.writeHead(500)
        res.end("Local provider fixture failed")
      })
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const origin = `http://127.0.0.1:${server.address().port}`
    const worker = await extensionWorker()
    const previous = await worker.evaluate(async () => {
      const { config } = await globalThis.chrome.storage.local.get("config")
      return { providersConfig: config.providersConfig, queue: config.translate.requestQueueConfig, batch: config.translate.batchQueueConfig, prompts: config.translate.customPromptsConfig }
    })
    const base = previous.providersConfig.find(provider => provider.id === "e2e-local")
    assert.ok(base, "the disposable fixture provider must already exist")
    const provider = label => ({ ...base, baseURL: `${origin}/${label}/v1`, model: { ...base.model, customModel: `snapshot-model-${label}` } })
    const patterns = ["a", "b"].map(label => ({
      id: `snapshot-template-${label}`, name: `Snapshot template ${label.toUpperCase()}`,
      systemPrompt: `SNAPSHOT_TEMPLATE_${label.toUpperCase()}. Translate to {{targetLanguage}}. Return only the translated content.`,
      prompt: `Translate to {{targetLanguage}}:\n\n[SNAPSHOT_USER_${label.toUpperCase()}]\n{{input}}`,
    }))
    const prompts = label => ({ promptId: `snapshot-template-${label}`, patterns })
    const evidence = { boundary: "Real content gestures and Chrome messages queue request snapshots; a local HTTP server records the actual model, endpoint and prompt template, then the same paragraph is translated again through the persistent cache", records }
    try {
      await h.configure({ providersConfig: [provider("a")], translate: { customPromptsConfig: prompts("a") } })
      await prepareHost(name, `<p id="snapshot-blocker-1">Provider snapshot token blocker one is held at the real local HTTP endpoint.</p><p id="snapshot-blocker-2">Provider snapshot token blocker two keeps the target waiting for another token.</p><p id="snapshot-blocker-3">Provider snapshot token blocker three keeps the original provider request queued.</p><p id="snapshot-blocker-4">Provider snapshot token blocker four prevents a settings save from racing the target's execution.</p><p id="snapshot-target">${target}</p>`)
      await inContentWorld(`(${observeProviderSnapshots.toString()})()`)
      await publicMessage("setTranslateBatchQueueConfig", { maxItemsPerBatch: 1, maxCharactersPerBatch: 1 })
      await publicMessage("setTranslateRequestQueueConfig", { rate: 1, capacity: 1 })
      await nodeGesture(page, "#snapshot-blocker-1")
      await until(() => held.length === 1, "the first actual model-A HTTP request is held before queued provider changes")
      for (const id of ["#snapshot-blocker-2", "#snapshot-blocker-3", "#snapshot-blocker-4", "#snapshot-target"])
        await nodeGesture(page, id)
      await until(async () => await inContentWorld(`globalThis.__E2E_PROVIDER_SNAPSHOTS__.some(entry => entry.text === ${JSON.stringify(target)})`), "the real content script sent the original model-A target snapshot")
      assert.equal(records.some(record => record.input?.includes(target)), false, "the target must remain queued before changing the actual saved provider")
      evidence.originalPayloads = await inContentWorld("globalThis.__E2E_PROVIDER_SNAPSHOTS__")
      await h.configure({ providersConfig: [provider("b")], translate: { customPromptsConfig: prompts("b") } })
      for (const release of held.splice(0))
        release()
      await until(() => hasTranslation(page, target), "the queued original paragraph completed after the provider settings changed")
      evidence.queuedResult = await page.locator("#snapshot-target").textContent()
      await page.evaluate((text) => {
        const paragraph = document.createElement("p")
        paragraph.id = "snapshot-current-b"
        paragraph.textContent = text
        document.querySelector("#article").append(paragraph)
      }, freshB)
      await nodeGesture(page, "#snapshot-current-b")
      await until(() => hasTranslation(page, freshB), "a new request uses the saved provider B")
      assert.ok(records.some(record => record.input?.includes(freshB) && record.model === "snapshot-model-b" && record.route === "/b/v1/chat/completions"
        && record.system.includes("SNAPSHOT_TEMPLATE_B") && record.input.includes("[SNAPSHOT_USER_B]")), "a new provider-B request must really reach the model-B endpoint with the newly selected prompt template")
      await h.configure({ providersConfig: [provider("a")], translate: { customPromptsConfig: prompts("a") } })
      await nodeGesture(page, "#snapshot-target")
      await until(async () => await page.locator("#snapshot-target").textContent() === target, "toggling the original target restores its exact source before repeating the A request")
      const requestsBeforeCache = records.length
      await nodeGesture(page, "#snapshot-target")
      await until(() => hasTranslation(page, target), "the same original provider-A paragraph translated again")
      evidence.repeatedResult = await page.locator("#snapshot-target").textContent()
      evidence.repeatWasCacheHit = !records.slice(requestsBeforeCache).some(record => record.input?.includes(target))
      evidence.finalPayloads = await inContentWorld("globalThis.__E2E_PROVIDER_SNAPSHOTS__")
      await page.screenshot({ path: path.join(outputPath, `${name}.png`) })
      const targetRecord = records.find(record => record.input?.includes(target))
      assert.equal(targetRecord.model, "snapshot-model-a", "queued work must keep the actual model from its original cache snapshot")
      assert.equal(targetRecord.route, "/a/v1/chat/completions", "queued work must keep the actual endpoint from its original cache snapshot")
      assert.ok(targetRecord.system.includes("SNAPSHOT_TEMPLATE_A") && targetRecord.input.includes("[SNAPSHOT_USER_A]"), "queued work must keep the actual system and user prompt templates from its original cache snapshot")
      assert.ok(evidence.repeatedResult.includes("[provider snapshot-A]"), "the provider-A cache key must never return a result generated by provider B")
      assert.ok(evidence.repeatedResult.includes("[template-A]"), "the original prompt-template cache identity must never return output generated by a newer template")
      const originalTarget = evidence.originalPayloads.find(entry => entry.text === target)
      const repeatedTarget = evidence.finalPayloads.filter(entry => entry.text === target).at(-1)
      assert.equal(repeatedTarget.hash, originalTarget.hash, "switching back to the same original configuration must reproduce the exact original cache identity")
      assert.equal(evidence.repeatWasCacheHit, true, "repeating an unchanged original request should use its correctly owned persistent cache")
    }
    finally {
      await writeFile(path.join(outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      for (const release of held.splice(0))
        release()
      await h.configure({ providersConfig: previous.providersConfig, translate: { customPromptsConfig: previous.prompts } })
      await publicMessage("setTranslateRequestQueueConfig", previous.queue)
      await publicMessage("setTranslateBatchQueueConfig", previous.batch)
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  await check("background-cross-origin-bootstrap-does-not-inherit-old-session", async () => {
    const name = "background-cross-origin-bootstrap-does-not-inherit-old-session"
    await prepareHost(name, "<p>Page translation is enabled for this original origin before a real navigation.</p>")
    await page.keyboard.press("Alt+KeyE")
    await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === true, "the original origin has an explicitly enabled page session")
    await until(async () => await page.locator(".vibe-reading-spinner").count() === 0, "the original page translations completed before navigation")
    const worker = await extensionWorker()
    const tabId = await worker.evaluate(async url => (await globalThis.chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url())
    assert.equal(typeof tabId, "number", "navigation must reuse an actual native Chrome tab")
    const key = `translationState.${tabId}`
    const label = "cross-origin-cleanup-state"
    const nextOrigin = h.origin.replace("127.0.0.1", "localhost")
    const evidence = { boundary: "The old onCommitted cleanup's actual session-storage read completes natively but its reply is held while the new-origin content script bootstraps", beforeOrigin: h.origin, nextOrigin }
    await worker.evaluate(installStorageBoundary)
    await worker.evaluate(plan => globalThis.__E2E_NATIVE_STORAGE__.plans.push(plan), { area: "session", method: "get", key, action: "hold", label })
    try {
      await page.goto(`${nextOrigin}/audit-cross-origin-no-inherited-session`)
      await until(() => worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.held.some(entry => entry.label === value), label), "the actual old-origin navigation cleanup is pending")
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "the new-origin production content script bootstrapped")
      evidence.bootstrapEnabled = await publicMessage("getEnablePageTranslationFromContentScript")
      await worker.evaluate(value => globalThis.__E2E_NATIVE_STORAGE__.release(value), label)
      await until(() => worker.evaluate(() => globalThis.__E2E_NATIVE_STORAGE__.calls.every(call => call.settled)), "old navigation cleanup and new-origin native storage calls settled")
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      evidence.afterCleanupEnabled = await publicMessage("getEnablePageTranslationFromContentScript")
      evidence.savedState = await worker.evaluate(async stateKey => (await globalThis.chrome.storage.session.get(stateKey))[stateKey], key)
      evidence.translationWrappers = await page.locator(".vibe-reading-translated-content-wrapper").count()
      await page.screenshot({ path: path.join(outputPath, `${name}.png`) })
      assert.equal(evidence.bootstrapEnabled, false, "a new origin's bootstrap read must never inherit the old origin's enabled state")
      assert.equal(evidence.afterCleanupEnabled, false, "new-origin bootstrap must not write a new enabled session that defeats old-origin cleanup")
      assert.equal(evidence.translationWrappers, 0, "a cross-origin page must retain its source until the reader explicitly enables translation")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === true, "an explicit reader action can start the new-origin session")
      await until(() => hasTranslation(page, "A reader revisits"), "the explicitly enabled new origin translates normally")
      evidence.explicitNewSessionRecovered = true
    }
    finally {
      await worker.evaluate((value) => {
        const state = globalThis.__E2E_NATIVE_STORAGE__
        state.plans = state.plans.filter(plan => plan.label !== value)
        if (state.held.some(entry => entry.label === value))
          state.release(value)
      }, label)
      await writeFile(path.join(outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
    }
  })
}
