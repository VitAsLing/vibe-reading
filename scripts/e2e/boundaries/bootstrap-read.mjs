import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

// Every request reaches Chrome normally. Only the first successful native
// bootstrap true reply is held; errors retain their original delivery scope.
function installBootstrapReadReplyBoundary() {
  const runtime = globalThis.chrome.runtime
  const nativeSend = runtime.sendMessage
  const state = globalThis.__E2E_BOOTSTRAP_READ__ = {
    holdNext: true, calls: [], held: [], installedAt: Date.now(),
  }
  state.release = () => {
    for (const release of state.held.splice(0))
      release()
  }
  const observed = (...args) => {
    const message = args.find(value => value && typeof value === "object" && typeof value.type === "string")
    const canHold = state.holdNext && message?.type === "getEnablePageTranslationFromContentScript"
    if (canHold)
      state.holdNext = false
    const call = {
      type: message?.type, enabled: message?.data?.enabled,
      text: message?.data?.text ?? message?.data?.prompt,
      forwarded: true, forwardedAt: Date.now(), delivered: false,
    }
    state.calls.push(call)
    const receive = (reply, lastError, deliver) => {
      call.nativeRepliedAt = Date.now()
      call.nativeBooleanResult = typeof reply?.res === "boolean" ? reply.res : undefined
      call.error = reply?.err?.message ?? lastError
      const finish = () => {
        call.delivered = true
        call.deliveredAt = Date.now()
        return deliver()
      }
      if (canHold && reply?.res === true && !call.error) {
        call.held = true
        state.held.push(finish)
        return
      }
      return finish()
    }
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null
    if (callback) {
      const forwarded = [...args]
      forwarded[forwarded.length - 1] = reply => receive(reply, runtime.lastError?.message, () => callback(reply))
      return nativeSend.apply(runtime, forwarded)
    }
    return nativeSend.apply(runtime, args).then(reply => new Promise((resolve) => {
      receive(reply, undefined, () => resolve(reply))
    }), (error) => {
      call.nativeRepliedAt = Date.now()
      call.delivered = true
      call.deliveredAt = Date.now()
      call.error = error.message
      throw error
    })
  }
  runtime.sendMessage = observed
  state.restore = () => {
    state.holdNext = false
    state.release()
    if (runtime.sendMessage === observed)
      runtime.sendMessage = nativeSend
  }
  return { runtimeId: runtime.id, url: location.href, installedAt: state.installedAt }
}

function armNativeBootstrapInjection(target, installBoundary) {
  const state = globalThis.__E2E_BOOTSTRAP_INJECTION__ = { registeredAt: Date.now(), listenerActive: true }
  const listener = async (details) => {
    if (details.tabId !== target.tabId || details.frameId !== 0 || details.url !== target.url)
      return
    globalThis.chrome.webNavigation.onCommitted.removeListener(listener)
    state.listenerActive = false
    state.details = { tabId: details.tabId, frameId: details.frameId, documentId: details.documentId, url: details.url }
    state.executeRequestedAt = Date.now()
    let timeout
    try {
      state.results = await Promise.race([
        globalThis.chrome.scripting.executeScript({
          target: { tabId: target.tabId, documentIds: [details.documentId] },
          world: "ISOLATED", injectImmediately: true, func: installBoundary,
        }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Native bootstrap boundary injection timed out")), 6000)
        }),
      ])
      state.completedAt = Date.now()
    }
    catch (error) {
      state.error = error.message
    }
    finally {
      clearTimeout(timeout)
    }
  }
  state.restore = () => {
    globalThis.chrome.webNavigation.onCommitted.removeListener(listener)
    state.listenerActive = false
  }
  globalThis.chrome.webNavigation.onCommitted.addListener(listener)
}

// Only this fixture HTML receives a parser-blocking external script. Its real
// request waits for native isolated-world injection, then loads empty JavaScript.
// The extension package and its normal document_idle entrypoint are unchanged.
async function armReloadBoundary(h, evidence, worker, tabId) {
  const url = h.page.url()
  const gateURL = `${h.origin}/e2e-bootstrap-install-gate.js`
  const gateTasks = new Set()
  let cancelGate
  let disposing
  let stopPolling = false
  evidence.fixtureGate = { documentURL: url, scriptURL: gateURL }
  const cancelled = new Promise((resolve) => {
    cancelGate = resolve
  })
  await worker.evaluate(`(${armNativeBootstrapInjection.toString()})(${JSON.stringify({ tabId, url })}, (${installBootstrapReadReplyBoundary.toString()}))`)
  // Poll immediately: the script route awaits this promise while reload is still
  // in progress, so readiness must never depend on reload's completion.
  const ready = (async () => {
    let installed
    await h.until(async () => {
      if (stopPolling)
        return true
      installed = await worker.evaluate(() => {
        const state = globalThis.__E2E_BOOTSTRAP_INJECTION__
        return { registeredAt: state.registeredAt, details: state.details, executeRequestedAt: state.executeRequestedAt, completedAt: state.completedAt, results: state.results, error: state.error }
      })
      if (installed.error)
        throw new Error(installed.error)
      return !!installed.completedAt
    }, "the genuine navigation-triggered native isolated-world injection completes")
    if (stopPolling)
      throw new Error("Native fixture installation was cancelled during cleanup")
    assert.equal(installed.results.length, 1, "the native injection targets exactly the actual new top document")
    const result = installed.results[0]
    assert.equal(result.frameId, 0)
    assert.equal(result.documentId, installed.details.documentId)
    assert.equal(result.result.runtimeId, h.extensionId, "the native script executed in this extension's actual isolated world")
    assert.equal(result.result.url, url)
    evidence.installation = installed
  })()
  void ready.catch(() => {})
  const scriptRoute = (route) => {
    const task = (async () => {
      evidence.fixtureGate.requestedAt = Date.now()
      try {
        await Promise.race([ready, cancelled])
      }
      catch (error) {
        evidence.fixtureGate.installationError = error.message
      }
      await route.fulfill({ status: 200, contentType: "application/javascript", headers: { "cache-control": "no-store" }, body: "" })
      evidence.fixtureGate.releasedAt = Date.now()
    })()
    gateTasks.add(task)
    void task.then(() => gateTasks.delete(task), (error) => {
      gateTasks.delete(task)
      evidence.fixtureGate.releaseError = error.message
    })
    return task
  }
  const documentRoute = async (route) => {
    const response = await route.fetch({ timeout: 6000 })
    const original = await response.text()
    assert.match(original, /<head>/i, "the real fixture response supplies its HTML head")
    await route.fulfill({ response, body: original.replace(/<head>/i, `<head><script src="${gateURL}"></script>`) })
    evidence.fixtureGate.documentForwardedAt = Date.now()
  }
  await h.page.route(gateURL, scriptRoute)
  await h.page.route(url, documentRoute)
  return {
    ready: () => ready,
    dispose() {
      disposing ??= (async () => {
        stopPolling = true
        cancelGate()
        const cleanups = await Promise.allSettled([
          worker.evaluate(() => globalThis.__E2E_BOOTSTRAP_INJECTION__.restore()),
          h.page.unroute(url, documentRoute),
          h.page.unroute(gateURL, scriptRoute),
          ...gateTasks,
        ])
        evidence.fixtureGate.disposedAt = Date.now()
        const errors = cleanups.filter(result => result.status === "rejected").map(result => result.reason.message)
        if (errors.length)
          throw new Error(`Native fixture gate cleanup failed: ${errors.join("; ")}`)
      })()
      return disposing
    },
  }
}

export async function runBootstrapReadCases(h) {
  const name = "state-bootstrap-old-enabled-read-after-user-stop"
  await h.check(name, async () => {
    const warmMarker = "The reader enables this article before a same-origin reload preserves the real page session."
    const probeMarker = "BOOTSTRAP_STOP_PROBE A stopped reader must keep this newly inserted paragraph original after an older enabled bootstrap reply arrives."
    const evidence = {
      name, translationMode: h.translationMode,
      boundary: "The actual first getEnablePageTranslationFromContentScript request is forwarded; only its successful native true reply is delayed",
      snapshots: [], phases: [],
    }
    let hook
    let worker
    let tabId
    let failure
    const inWorld = expression => h.inContentWorld(expression)
    const mark = async (phase) => {
      evidence.phases.push({ phase, at: Date.now() })
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      process.stdout.write(`${name}: ${phase}\n`)
    }
    const readBoundary = () => inWorld("(() => { const state = globalThis.__E2E_BOOTSTRAP_READ__; return state && { calls: state.calls, heldCount: state.held.length }; })()")
    const readState = () => worker.evaluate(async (id) => {
      const key = `translationState.${id}`
      return (await globalThis.chrome.storage.session.get(key))[key] ?? null
    }, tabId)
    const snapshot = async (step) => {
      const item = {
        step, persisted: await readState(), boundary: await readBoundary(),
        dom: await h.page.evaluate(() => ({
          url: location.href, title: document.title,
          wrapperCount: document.querySelectorAll(".vibe-reading-translated-content-wrapper").length,
          articleText: document.querySelector("#article").textContent,
        })),
        translationHttpCount: h.requests.filter(request => request.kind === "translation").length,
      }
      evidence.snapshots.push(item)
      return item
    }
    try {
      await h.prepareHost(name, `<p id="bootstrap-warm">${warmMarker}</p>`)
      worker = await h.extensionWorker()
      tabId = await worker.evaluate(async url => (await globalThis.chrome.tabs.query({})).find(tab => tab.url === url)?.id, h.page.url())
      assert.equal(typeof tabId, "number", "Chrome supplies the actual fixture tab ID")
      evidence.beforeReloadDocument = await worker.evaluate(id => globalThis.chrome.webNavigation.getFrame({ tabId: id, frameId: 0 }), tabId)
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(async () => (await readState())?.enabled === true && await h.hasTranslation(h.page, warmMarker), "the genuine shortcut enables and translates the original article")
      await mark("original-article-enabled")

      hook = await armReloadBoundary(h, evidence, worker, tabId)
      await mark("native-navigation-installer-and-fixture-gate-armed")
      await h.page.reload({ timeout: 20000 })
      await hook.ready()
      await hook.dispose()
      hook = undefined
      await mark("native-world-installed-and-fixture-gate-disposed")
      await h.until(async () => (await readBoundary())?.heldCount === 1, "the new host's successful native enabled reply is held")
      evidence.afterReloadDocument = await worker.evaluate(id => globalThis.chrome.webNavigation.getFrame({ tabId: id, frameId: 0 }), tabId)
      assert.equal(evidence.afterReloadDocument.url, evidence.beforeReloadDocument.url, "reload keeps the exact same URL")
      assert.notEqual(evidence.afterReloadDocument.documentId, evidence.beforeReloadDocument.documentId, "Chrome reports a genuinely new top document")
      assert.equal(evidence.installation.results[0].documentId, evidence.afterReloadDocument.documentId, "the native injection belongs to Chrome's current reloaded document")
      const held = await snapshot("native-enabled-reply-held")
      const read = held.boundary.calls.find(call => call.held)
      assert.equal(read?.type, "getEnablePageTranslationFromContentScript")
      assert.equal(read?.nativeBooleanResult, true, "the held true value originates from the real background handler")
      assert.ok(read.forwarded && read.nativeRepliedAt && !read.delivered && !read.error)
      assert.ok(evidence.installation.completedAt <= read.forwardedAt, "the native boundary finished before the production bootstrap's first real state read")
      assert.equal(held.dom.wrapperCount, 0, "bootstrap has not applied its pending enabled result")
      await mark("genuine-enabled-bootstrap-reply-held")

      evidence.firstUserGestureAt = Date.now()
      assert.ok(evidence.fixtureGate.requestedAt && evidence.fixtureGate.releasedAt <= evidence.firstUserGestureAt
        && evidence.fixtureGate.disposedAt <= evidence.firstUserGestureAt, "the fixture loading gate is fully released and removed before the reader interacts")
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(async () => (await readBoundary()).calls.some(call => call.type === "setAndNotifyPageTranslationStateChangedByManager" && call.enabled === true && call.delivered && call.nativeBooleanResult === true)
        && await h.hasTranslation(h.page, "A reader revisits"), "the reader explicitly starts the new document while its bootstrap reply remains held")
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(async () => (await readState())?.enabled === false && await h.page.locator(".vibe-reading-translated-content-wrapper").count() === 0,
        "the reader explicitly stops and restores the new document")
      await h.until(async () => (await readBoundary()).calls.filter(call => !call.held).every(call => call.delivered), "the reader's real start and stop messages complete")
      await h.page.evaluate((text) => {
        const paragraph = document.createElement("p")
        paragraph.id = "bootstrap-stop-probe"
        paragraph.textContent = text
        document.querySelector("#article").replaceChildren(paragraph)
      }, probeMarker)
      const stopped = await snapshot("reader-stopped-before-release")
      assert.equal(stopped.persisted.enabled, false)
      assert.equal(stopped.dom.wrapperCount, 0)
      assert.equal(stopped.boundary.heldCount, 1, "the original enabled reply is still pending after the confirmed stop")
      await mark("reader-stop-persisted-and-dom-restored")
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}-stopped.png`) })
      const requestStart = h.requests.length
      const messageStart = stopped.boundary.calls.length

      await inWorld("globalThis.__E2E_BOOTSTRAP_READ__.release()")
      await h.until(async () => (await readBoundary()).calls.some(call => call.held && call.delivered), "the original real enabled reply is delivered without changing its value")
      await h.until(async () => (await readBoundary()).calls.some(call => call.type === "reportDetectedPageLanguage" && call.delivered), "the released production bootstrap completes its real page-language report")
      await h.until(async () => (await readBoundary()).calls.every(call => call.delivered), "all observed native message replies have completed")
      await inWorld("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      // Capture an actual resurrection fully before reporting the failed contract.
      if ((await readState())?.enabled === true)
        await h.until(() => h.hasTranslation(h.page, probeMarker), "a regressed bootstrap visibly translates the new stopped paragraph")
      const released = await snapshot("old-native-reply-released")
      evidence.httpAfterRelease = h.requests.slice(requestStart).filter(request => request.kind === "translation")
      evidence.translationMessagesAfterRelease = released.boundary.calls.slice(messageStart).filter(call => call.type === "enqueueTranslateRequest")
      await mark("old-reply-released-and-native-results-captured")
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}-released.png`) })
      assert.equal(released.persisted.enabled, false, "an old bootstrap enabled reply must preserve the reader's confirmed stopped state")
      assert.equal(released.dom.wrapperCount, 0, "the old bootstrap reply must not recreate translated content")
      assert.equal(evidence.httpAfterRelease.length, 0, "the old bootstrap reply must not issue a new translation HTTP request")
      assert.equal(evidence.translationMessagesAfterRelease.length, 0, "a translation cache hit must not hide a newly enqueued stopped request")
    }
    catch (error) {
      failure = error
      evidence.failure = error.message
    }
    finally {
      const cleanupErrors = []
      if (hook) {
        try {
          await hook.dispose()
        }
        catch (error) {
          cleanupErrors.push(error.message)
        }
      }
      try {
        await inWorld("globalThis.__E2E_BOOTSTRAP_READ__?.restore()")
      }
      catch (error) {
        cleanupErrors.push(error.message)
      }
      if (typeof tabId === "number") {
        try {
          await h.publicMessage("tryToSetEnablePageTranslationByTabId", { tabId, enabled: false })
        }
        catch (error) {
          cleanupErrors.push(error.message)
        }
      }
      evidence.cleanupErrors = cleanupErrors
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(evidence, null, 2))
      if (cleanupErrors.length && !failure)
        failure = new Error(`Bootstrap acceptance cleanup failed: ${cleanupErrors.join("; ")}`)
    }
    if (failure)
      throw failure
  })
}
