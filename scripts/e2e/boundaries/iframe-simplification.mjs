import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

// Only delay a successful reply after Chrome has executed the real host file.
// Native failures keep their original rejection/callback and lastError scope.
function installIframeScriptingBoundary(tabId) {
  const scripting = globalThis.chrome.scripting
  const navigation = globalThis.chrome.webNavigation
  const execute = scripting.executeScript.bind(scripting)
  const frames = navigation.getAllFrames.bind(navigation)
  const state = globalThis.__E2E_IFRAME_SCRIPTING__ = {
    calls: [], held: [], holdNextHostReply: true,
    readFrames: () => frames({ tabId }),
  }
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

  function observe(native, args, entry, canHold) {
    state.calls.push(entry)
    const completed = (result) => {
      entry.result = copy(result)
      entry.nativeCompletedAt = Date.now()
    }
    const deliver = (action) => {
      entry.deliveredAt = Date.now()
      return action()
    }
    const hold = (release) => {
      if (!canHold || !state.holdNextHostReply)
        return false
      state.holdNextHostReply = false
      entry.held = true
      state.held.push({ entry, release: () => deliver(release) })
      return true
    }
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null
    try {
      entry.forwarded = true
      entry.forwardedAt = Date.now()
      if (callback) {
        const forwarded = [...args]
        forwarded[forwarded.length - 1] = (result) => {
          entry.error = globalThis.chrome.runtime.lastError?.message
          completed(result)
          if (entry.error || !hold(() => callback(result)))
            return deliver(() => callback(result))
        }
        return native(...forwarded)
      }
      return native(...args).then((result) => {
        completed(result)
        if (canHold && state.holdNextHostReply)
          return new Promise(resolve => hold(() => resolve(result)))
        return deliver(() => result)
      }, (error) => {
        entry.error = error.message
        entry.nativeCompletedAt = Date.now()
        entry.deliveredAt = Date.now()
        throw error
      })
    }
    catch (error) {
      entry.error = error.message
      entry.deliveredAt = Date.now()
      throw error
    }
  }

  const executeObserved = (...args) => {
    const options = args[0]
    if (options?.target?.tabId !== tabId || !options.files?.includes("/content-scripts/host.js"))
      return execute(...args)
    return observe(execute, args, { method: "executeScript", arguments: copy(options) }, true)
  }
  const framesObserved = (...args) => {
    if (args[0]?.tabId !== tabId)
      return frames(...args)
    return observe(frames, args, { method: "getAllFrames", arguments: copy(args[0]) }, false)
  }
  scripting.executeScript = executeObserved
  navigation.getAllFrames = framesObserved
  state.release = () => {
    for (const item of state.held.splice(0))
      item.release()
  }
  state.restore = () => {
    state.release()
    if (scripting.executeScript === executeObserved)
      scripting.executeScript = execute
    if (navigation.getAllFrames === framesObserved)
      navigation.getAllFrames = frames
  }
}

async function childHostFlag(worker, target) {
  const results = await worker.evaluate(value => globalThis.chrome.scripting.executeScript({
    target: value,
    func: () => window.__READ_FROG_HOST_INJECTED__ === true,
  }), target)
  assert.equal(results.length, 1, "the native diagnostic must target exactly one real iframe")
  return results[0]
}

export async function runIframeSimplificationCases(h) {
  const {
    check, page, origin, extensionWorker, prepareHost, until, nodeGesture,
    hasTranslation, publicMessage, inContentWorld, waitForMessageResult,
    recordMessages, outputPath, translationMode,
  } = h
  const name = "iframe-held-injection-reply-same-url-reload-page-start"
  await check(name, async () => {
    const frameURL = `${origin}/audit-frame-${name}`
    const firstMarker = "First manual paragraph requests real iframe initialization exactly once."
    const secondMarker = "Second manual paragraph preserves the existing once per document injection contract."
    const childMarker = "The reloaded child article must initialize and translate when its reader enables page translation."
    const evidence = { name, translationMode, frameURL, snapshots: [], controls: {} }
    await prepareHost(name, `<p id="iframe-first">${firstMarker}</p><p id="iframe-second">${secondMarker}</p><iframe id="iframe-reload" src="${frameURL}" style="width:900px;height:450px"></iframe>`)
    let frame
    await until(() => {
      frame = page.frames().find(candidate => candidate.url() === frameURL)
      return !!frame
    }, "the real child document loaded before its first injection")
    await frame.waitForLoadState("domcontentloaded")
    const worker = await extensionWorker()
    const tabId = await worker.evaluate(async url =>
      (await globalThis.chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url())
    assert.equal(typeof tabId, "number", "the fixture must have a native tab ID")
    await worker.evaluate(installIframeScriptingBoundary, tabId)
    const readFrames = () => worker.evaluate(() => globalThis.__E2E_IFRAME_SCRIPTING__.readFrames())
    const metadata = () => worker.evaluate(() => ({
      calls: globalThis.__E2E_IFRAME_SCRIPTING__.calls,
      held: globalThis.__E2E_IFRAME_SCRIPTING__.held.map(item => ({ arguments: item.entry.arguments })),
    }))
    const injectionMessages = () => inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.messages.filter(message => message.type === 'injectCurrentIframesAfterTopFrameNodeTranslation')")
    let target
    try {
      const initialFrames = await readFrames()
      evidence.snapshots.push({ step: "before-first-gesture", frames: initialFrames })
      const firstDocument = initialFrames.find(item => item.frameId !== 0 && item.url === frameURL)
      assert.equal(typeof firstDocument?.documentId, "string", "Chrome must expose the genuine getAllFrames documentId for this document identity probe")
      target = { tabId, frameIds: [firstDocument.frameId] }
      const initialHost = await childHostFlag(worker, target)
      evidence.controls.initialHost = initialHost
      assert.equal(initialHost.result, false, "an inactive ordinary iframe must begin without the host runtime")
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false)

      await nodeGesture(page, "#iframe-first")
      await until(() => hasTranslation(page, firstMarker), "the first real paragraph gesture completed")
      await until(async () => (await metadata()).held.length === 1, "the genuine host execution result is held after native completion")
      const firstCalls = (await metadata()).calls.filter(call => call.method === "executeScript")
      assert.equal(firstCalls.length, 1, "the first gesture must forward exactly one genuine host-file injection")
      assert.equal(firstCalls[0].result[0].documentId, firstDocument.documentId,
        "the held reply must originate from the actual first child document")
      assert.equal((await childHostFlag(worker, target)).result, true,
        "holding the reply must not prevent native host execution")
      assert.equal((await injectionMessages())[0]?.settled, false,
        "the paragraph injection message must still await the delayed native reply")

      await Promise.all([
        frame.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.locator("#iframe-reload").evaluate(element => element.setAttribute("src", element.getAttribute("src"))),
      ])
      let reloadedDocument
      await until(async () => {
        reloadedDocument = (await readFrames()).find(item => item.frameId === firstDocument.frameId)
        return reloadedDocument?.url === frameURL && reloadedDocument.documentId !== firstDocument.documentId
      }, "the same child frame navigated to a new document at the identical URL")
      assert.equal(typeof reloadedDocument.documentId, "string")
      evidence.snapshots.push({ step: "same-url-new-document", frames: await readFrames() })
      await frame.waitForLoadState("domcontentloaded")
      await frame.evaluate((text) => {
        document.querySelector("#article").innerHTML = "<p id=\"iframe-child-source\"></p>"
        document.querySelector("#iframe-child-source").textContent = text
      }, childMarker)
      const reloadedHost = await childHostFlag(worker, target)
      evidence.controls.reloadedHost = reloadedHost
      assert.equal(reloadedHost.result, false, "page translation off must leave the reloaded child uninjected")
      assert.equal(reloadedHost.documentId, reloadedDocument.documentId)
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false)

      await worker.evaluate(() => globalThis.__E2E_IFRAME_SCRIPTING__.release())
      await until(async () => (await injectionMessages()).every(message => message.settled), "the earlier paragraph injection message accepted its real delayed reply")
      assert.equal((await childHostFlag(worker, target)).result, false,
        "delivering an old reply must not itself inject the new document")
      await nodeGesture(page, "#iframe-second")
      await until(() => hasTranslation(page, secondMarker), "a distinct second manual paragraph translated")
      await waitForMessageResult("enqueueTranslateRequest", secondMarker)
      await inContentWorld("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      evidence.controls.nodeInjectionMessages = await injectionMessages()
      assert.equal(evidence.controls.nodeInjectionMessages.length, 1,
        "the second paragraph gesture must preserve the existing once-only iframe scan")
      assert.equal((await metadata()).calls.filter(call => call.method === "executeScript").length, 1,
        "the second paragraph must not invent a new native host injection")
      assert.equal(await publicMessage("getEnablePageTranslationFromContentScript"), false)

      const scanCount = (await metadata()).calls.filter(call => call.method === "getAllFrames").length
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === true,
        "the real page shortcut enabled translation")
      await until(async () => {
        const calls = (await metadata()).calls
        return calls.filter(call => call.method === "getAllFrames" && call.deliveredAt).length > scanCount
          && calls.filter(call => call.method === "executeScript").every(call => call.deliveredAt)
      }, "the enabled page completed its second genuine iframe scan")
      evidence.controls.afterPageStart = await metadata()
      const hostCalls = evidence.controls.afterPageStart.calls.filter(call => call.method === "executeScript")
      assert.equal(hostCalls.length, 2, "page start must forward a second host injection for the new same-URL document")
      assert.equal(hostCalls[1].result[0].documentId, reloadedDocument.documentId,
        "the new injection must complete in Chrome's current child document")
      const finalHost = await childHostFlag(worker, target)
      evidence.controls.finalHost = finalHost
      assert.equal(finalHost.result, true, "the new isolated world must contain the real host runtime")
      await until(() => hasTranslation(frame, childMarker), "the newly initialized child article translated")
      evidence.controls.childTranslationCount = await frame.locator("#article .vibe-reading-translated-content-wrapper").count()
      assert.equal(evidence.controls.childTranslationCount, 1, "the real child source must translate once in either translation mode")
    }
    finally {
      try {
        evidence.native = await metadata()
        evidence.snapshots.push({ step: "final", frames: await readFrames() })
        if (target)
          evidence.childHost = await childHostFlag(worker, target)
        await writeFile(path.join(outputPath, "iframe-simplification.json"), JSON.stringify(evidence, null, 2))
        await page.screenshot({ path: path.join(outputPath, `${name}.png`) })
        await recordMessages(name)
      }
      finally {
        await worker.evaluate(() => globalThis.__E2E_IFRAME_SCRIPTING__.restore())
      }
    }
  })
}
