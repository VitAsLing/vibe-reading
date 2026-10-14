import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

// Observe only the worker's own locale resources. The native request arguments
// and original Response remain unchanged; a clone supplies passive evidence.
function installWorkerLocaleObserver(extensionId) {
  const nativeFetch = globalThis.fetch
  const prefix = `chrome-extension://${extensionId}/_locales/`
  const state = globalThis.__E2E_IFRAME_LOCALE_FETCH__ = { calls: [], captures: [] }
  const observed = (...args) => {
    const input = args[0]
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(prefix))
      return nativeFetch.apply(globalThis, args)
    const entry = { url, forwardedAt: Date.now(), forwarded: true }
    state.calls.push(entry)
    return nativeFetch.apply(globalThis, args).then((response) => {
      entry.status = response.status
      entry.nativeCompletedAt = Date.now()
      const capture = response.clone().json().then((messages) => {
        entry.sample = messages.errorRecovery_saveFailed?.message
        entry.sampleCapturedAt = Date.now()
      }, (error) => {
        entry.captureError = error.message
      })
      state.captures.push(capture)
      return response
    }, (error) => {
      entry.error = error.message
      throw error
    })
  }
  globalThis.fetch = observed
  state.restore = () => {
    if (globalThis.fetch === observed)
      globalThis.fetch = nativeFetch
  }
}

async function observedLocaleReads(worker, start, expectedURL, locale) {
  const calls = await worker.evaluate(async (index) => {
    const state = globalThis.__E2E_IFRAME_LOCALE_FETCH__
    await Promise.all(state.captures)
    return state.calls.slice(index)
  }, start)
  const reads = calls.filter(call => call.url === expectedURL)
  assert.ok(reads.length > 0, "the child bootstrap must actually fetch its configured locale through the worker after the parent has booted")
  for (const read of reads) {
    assert.equal(read.forwarded, true)
    assert.equal(read.status, 200, "locale evidence must come from a successful native packaged-resource response")
    assert.equal(read.error, undefined)
    assert.equal(read.captureError, undefined)
    assert.equal(typeof read.sample, "string")
    assert.match(read.sample, locale === "zh-CN" ? /设置.*保存.*重试/ : /settings.*saved.*try again/i,
      "the fetched locale must contain the configured language's actual save-failure message")
  }
  return calls
}

export async function runLocaleIframeCases(h) {
  for (const restricted of [false, true]) {
    const name = restricted
      ? "locale-frame-resource-restriction-translates-and-recovers"
      : "locale-opaque-iframe-translates-reloads-and-preserves-page-language"
    await h.check(name, async () => {
      const frameURL = `${h.origin}/watch?locale-opaque-frame=1`
      const marker = "LOCALE_IFRAME_PARENT The reader enables translation for a page containing an embedded isolated document."
      const worker = await h.extensionWorker()
      const previous = await worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
      const observations = []
      const blockedRequests = []
      const localeURL = `chrome-extension://${h.extensionId}/_locales/**`
      if (restricted) {
        await h.page.route(localeURL, async (route) => {
          if (route.request().frame().url() === frameURL) {
            blockedRequests.push({ url: route.request().url(), frame: frameURL, reason: "blockedbyclient" })
            await route.abort("blockedbyclient")
          }
          else {
            await route.continue()
          }
        })
      }
      await worker.evaluate(installWorkerLocaleObserver, h.extensionId)
      try {
        for (const locale of ["zh-CN", "en"]) {
          const expectedLocaleURL = `chrome-extension://${h.extensionId}/_locales/${locale === "zh-CN" ? "zh_CN" : "en"}/messages.json`
          await h.configure({ uiLocale: locale })
          await h.prepareHost(`${name}-${locale}`, `<p id="locale-parent">${marker}</p><iframe id="locale-child" sandbox="allow-scripts" src="${frameURL}" style="width:900px;height:450px"></iframe>`)
          let frame
          await h.until(() => {
            frame = h.page.frames().find(candidate => candidate.url() === frameURL)
            return !!frame
          }, "the real sandboxed child document is loaded")
          await frame.waitForLoadState("domcontentloaded")
          const original = await frame.locator("#p1").textContent()
          const state = await frame.evaluate(() => ({ origin: globalThis.origin, href: location.href, lang: document.documentElement.lang }))
          assert.equal(state.origin, "null", "the real sandbox excludes allow-same-origin and gives the child an opaque origin")
          const pageStartCallIndex = await worker.evaluate(() => globalThis.__E2E_IFRAME_LOCALE_FETCH__.calls.length)
          await h.page.keyboard.press("Alt+KeyE")
          await h.until(() => h.hasTranslation(h.page, marker), "the parent translates through its normal page action")
          try {
            await h.until(() => h.hasTranslation(frame, original), "the embedded opaque document completes locale bootstrap and translates", 6000)
          }
          catch (error) {
            const manager = await h.context.newPage()
            try {
              await manager.goto(`chrome://extensions/?errors=${h.extensionId}`)
              const failures = await manager.evaluate(async id => (await globalThis.chrome.developerPrivate.getExtensionInfo(id)).runtimeErrors, h.extensionId)
              await writeFile(path.join(h.outputPath, `${name}-failed.json`), JSON.stringify({ locale, state, blockedRequests, failures }, null, 2))
            }
            finally {
              await manager.close()
            }
            throw error
          }
          const initialLocaleReads = await observedLocaleReads(worker, pageStartCallIndex, expectedLocaleURL, locale)
          assert.equal(await frame.locator("html").getAttribute("lang"), state.lang, "loading interface messages must not change the embedded page's document language")
          await h.page.screenshot({ path: path.join(h.outputPath, `${name}-${locale}.png`) })
          const reloadCallIndex = await worker.evaluate(() => globalThis.__E2E_IFRAME_LOCALE_FETCH__.calls.length)
          await Promise.all([
            frame.waitForNavigation({ waitUntil: "domcontentloaded" }),
            h.page.evaluate(url => document.querySelector("#locale-child").setAttribute("src", url), frameURL),
          ])
          await h.until(() => h.hasTranslation(frame, original), "the same-URL child reload initializes its new document while page translation remains enabled")
          const reloadedLocaleReads = await observedLocaleReads(worker, reloadCallIndex, expectedLocaleURL, locale)
          assert.equal(await frame.locator("html").getAttribute("lang"), state.lang, "the reloaded child keeps its source document language after loading the configured locale")
          await h.page.keyboard.press("Alt+KeyE")
          await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false
            && await frame.locator(".vibe-reading-translated-content-wrapper").count() === 0, "stopping restores both parent and embedded source")
          assert.equal(await frame.locator("#p1").textContent(), original)
          observations.push({ locale, ...state, expectedLocaleURL, pageStartCallIndex, initialLocaleReads, reloadCallIndex, reloadedLocaleReads,
            translated: true, reloaded: true, sourceRestored: true })
        }
        await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(observations, null, 2))
      }
      finally {
        await worker.evaluate(() => globalThis.__E2E_IFRAME_LOCALE_FETCH__.restore())
        if (restricted)
          await h.page.unroute(localeURL)
        await h.configure(previous)
      }
    })
  }
}
