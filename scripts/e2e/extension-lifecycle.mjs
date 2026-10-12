import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { runContentBoundaryCases } from "./boundaries/content.mjs"
import { runInputBoundaryCases } from "./boundaries/input.mjs"
import { runSettingsBoundaryCases } from "./boundaries/settings.mjs"
import { runStateBoundaryCases } from "./boundaries/state.mjs"
import { installStorageBoundary } from "./boundaries/storage.mjs"
import { runUIBoundaryCases } from "./boundaries/ui.mjs"

// This runs the production extension in Chromium. The remote model endpoint is
// a fixture; one case delays a real Chrome message before forwarding it. All
// extension code, storage, handlers, workers and DOM remain real.
const extensionPath = path.resolve(process.argv[2] ?? ".output/chrome-mv3")
const outputPath = path.resolve(process.argv[3] ?? ".output/acceptance/extension-lifecycle")
const baseline = process.argv.includes("--baseline")
const selectedCase = process.argv.find(value => value.startsWith("--case="))?.slice(7)
const translationMode = process.argv.includes("--translation-only") ? "translationOnly" : "bilingual"
const browserExecutable = process.env.E2E_BROWSER_EXECUTABLE ? path.resolve(process.env.E2E_BROWSER_EXECUTABLE) : undefined
await mkdir(outputPath, { recursive: true })
const started = Date.now()
const cases = []
const errors = []
const browserExceptions = []
const requests = []
const heldResponses = []
const heldMarkers = new Map()
const providerResponses = new Map()
const lifecycleEvents = []
const diagnosticFailures = []
const messageRecords = []
const pendingDiagnostics = new Set()
let providerStatus = 200
let holdPending = false
let context
let failure
let manifest
let sourceSnapshot
let origin
let browserVersion
let extensionId
let tracingStarted = false
let captureFailureState

function recordFailure(phase, error) {
  diagnosticFailures.push({ phase, atMs: Date.now() - started, message: error.message, stack: error.stack })
  failure ??= error
  process.stderr.write(`${phase}: ${error.stack ?? error}\n`)
}

async function diagnostic(phase, action) {
  let timeout
  try {
    await Promise.race([
      action(),
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Diagnostic timed out: ${phase}`)), 10000) }),
    ])
  }
  catch (error) {
    recordFailure(phase, error)
  }
  finally {
    clearTimeout(timeout)
  }
}

async function captureSourceAndBuild() {
  const manifestBytes = await readFile(path.join(extensionPath, "manifest.json"))
  manifest = JSON.parse(manifestBytes.toString("utf8"))
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" })
  const sourcePaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort()
  const sourceFiles = []
  for (const file of [...new Set(sourcePaths)]) {
    try {
      sourceFiles.push({ path: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") })
    }
    catch (error) {
      if (error.code !== "ENOENT")
        throw error
      sourceFiles.push({ path: file, deleted: true })
    }
  }
  const buildFiles = []
  const collectBuildFiles = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        await collectBuildFiles(path.join(directory, entry.name), `${relativePath}/`)
      }
      else {
        buildFiles.push({ path: relativePath, sha256: createHash("sha256").update(await readFile(path.join(directory, entry.name))).digest("hex") })
      }
    }
  }
  await collectBuildFiles(extensionPath)
  buildFiles.sort((a, b) => a.path.localeCompare(b.path))
  const scriptSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
  const backgroundSha256 = buildFiles.find(file => file.path === "background.js")?.sha256
  const hostSha256 = buildFiles.find(file => file.path === "content-scripts/host.js")?.sha256
  assert.ok(backgroundSha256 && hostSha256, "the production build must contain background and host scripts")
  sourceSnapshot = {
    capturedAt: new Date().toISOString(), revision, sourceStatus,
    diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--binary"])).digest("hex"),
    scriptSha256, sourceFiles, buildFiles,
    sourceSha256: createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex"),
    buildSha256: createHash("sha256").update(JSON.stringify(buildFiles)).digest("hex"),
    backgroundSha256, hostSha256,
  }
  await writeFile(path.join(outputPath, "source-and-build.json"), JSON.stringify(sourceSnapshot, null, 2))
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lifecycle Article</title>
<style>body{font:18px system-ui;max-width:850px;margin:30px auto;line-height:1.8}button{font-size:16px;margin:8px}p{padding:10px;background:#f6f6f6}#spacer{height:300px}</style></head>
<body><h1>Extension lifecycle acceptance</h1><nav class="notranslate"><button id="add">Add paragraph</button><button id="route">Change route</button><button id="pending">Add pending paragraph</button></nav>
<main id="article"><p id="p1">A reader revisits an open article after the extension background has stopped.</p><p id="p2">The provider can fail temporarily and a reader can retry without losing the original paragraph.</p><p id="p3">Page translation also follows new paragraphs and changes to the document title.</p></main><div id="spacer"></div>
<script>let counter=0;
document.querySelector('#add').onclick=()=>{const p=document.createElement('p');p.id='added-'+(++counter);p.textContent='Dynamic paragraph '+counter+' must be translated while the page session is active.';document.querySelector('#article').append(p)};
document.querySelector('#pending').onclick=()=>{const p=document.createElement('p');p.id='pending-paragraph';p.textContent='Pending response across extension reload must not modify an invalidated page.';document.querySelector('#article').append(p)};
document.querySelector('#route').onclick=()=>{history.pushState({},'', '/route-two');document.title='Second Route Article';document.querySelector('#article').innerHTML='<p id="route-paragraph">A different route should restart translation using the new article and title.</p>'};
</script></body></html>`

const mixedMarkup = `Mixed leading text must survive a provider failure <span id="mixed-inline">with the original inline span preserved.</span><div id="mixed-block">Nested block text must also retry independently without replacing the neighboring paragraph.</div>Trailing mixed text must remain available until its own retry succeeds.`
const mixedNeighbor = "A successful adjacent paragraph must remain translated while the mixed paragraph retries independently."
const sessionTexts = {
  "stop-success": "Held success after normal stop must never rewrite this original paragraph when the page is reused.",
  "stop-failure": "Held failure after normal stop must never mount an error in the reused block element of this article.",
  "spa-success": "Held success after SPA reuse must never replace the current route paragraph with an obsolete translation.",
  "spa-failure": "Held failure after SPA reuse must never mount obsolete error controls in a reused block element.",
  "ownership": "Held older owner must release its own translation state without unlocking a new request in this reused block.",
}
const languageTexts = {
  base: "An initial English article provides enough source text for the real extension to complete its language report before navigation begins.",
  oldA: "LANG_A_OLD An English article starts language detection, then remains pending while the reader visits a different article in another language.",
  oldRoundtripA: "LANG_ROUNDTRIP_A_OLD An older English article at the same address must not overwrite the language of a newer article after returning to that address.",
  chineseB: "LANG_B_CURRENT 这是一篇新打开的中文文章。读者切换页面之后，扩展应该分析当前页面的中文正文，而不能继续使用之前英文文章的语言检测结果。这段正文足够长，能够进行真实的页面语言采样并通过模拟模型接口返回中文语言代码。",
  currentFrenchA: "LANG_A_CURRENT_FR Ce nouvel article est écrit en français. Après le retour à la même adresse, le lecteur doit conserver la langue du document actuel, même si la détection de l'ancien article anglais arrive plus tard.",
}

function fixtureDocument(url) {
  let article
  let title
  if (url === "/mixed" || url === "/mixed-errors") {
    title = "Mixed Content Article"
    const markup = url === "/mixed-errors"
      ? mixedMarkup.replace("Mixed leading", "Storage reload mixed leading").replace("Nested block", "Storage reload nested block").replace("Trailing mixed", "Storage reload trailing mixed")
      : mixedMarkup
    article = `<p id="neighbor">${mixedNeighbor}</p><div id="mixed">${markup}</div>`
  }
  else if (url === "/pre-wrapper") {
    title = "Paragraph Preparation Article"
    article = `<div id="reuse">${mixedMarkup.replaceAll("mixed-", "prepare-")}</div>`
  }
  else if (url === "/frame-before-insertion") {
    title = "Paused Translation Frame Article"
    article = "<p id=\"reuse\">Held frame source must not leave an obsolete restoration snapshot when translation stops before its wrapper is inserted.</p>"
  }
  else if (url.startsWith("/session-")) {
    const scenario = url.slice("/session-".length)
    const tag = scenario.endsWith("success") ? "p" : "div"
    title = `Session ${scenario} Article`
    article = `<${tag} id="reuse">${sessionTexts[scenario]}</${tag}>`
  }
  else if (url === "/language-base") {
    title = "Initial Language Article"
    article = `<p id="language-text">${languageTexts.base}</p>`
  }
  else {
    return html
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px system-ui;max-width:850px;margin:30px auto;line-height:1.8}p,main>div{padding:10px;background:#f6f6f6}</style></head><body><main id="article">${article}</main></body></html>`
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(fixtureDocument(req.url))
      return
    }
    let body = ""
    for await (const chunk of req)
      body += chunk
    const payload = JSON.parse(body)
    const system = payload.messages.find(message => message.role === "system")?.content ?? ""
    const input = payload.messages.find(message => message.role === "user")?.content ?? ""
    const detection = system.includes("language detection assistant")
    const entry = { id: requests.length + 1, atMs: Date.now() - started, kind: detection ? "language" : "translation", input, status: detection ? 200 : providerStatus }
    requests.push(entry)
    res.on("close", () => {
      entry.closedAtMs = Date.now() - started
    })
    const reply = (status = entry.status) => {
      entry.releasedAtMs = Date.now() - started
      entry.status = status
      if (res.destroyed) {
        entry.disconnectedBeforeReply = true
        return
      }
      res.writeHead(entry.status, { "content-type": "application/json" })
      if (entry.status !== 200) {
        res.end(JSON.stringify({ error: { message: "E2E provider temporarily unavailable", type: "authentication_error" } }))
        return
      }
      const code = input.includes("LANG_A_CURRENT_FR") ? "fra" : input.includes("LANG_B_CURRENT") ? "cmn" : "eng"
      const text = detection
        ? JSON.stringify({ code })
        : input.replace(/^Translate to [^:]+:\s*/, "").split(/\n\s*%%\s*\n/).map((part) => {
            const response = [...providerResponses].find(([marker]) => part.includes(marker))?.[1]
            return response === "empty" ? "" : response === "echo" ? part.trim() : `[E2E translated] ${part.trim()}`
          }).join("\n%%\n")
      res.end(JSON.stringify({
        id: "e2e-local", object: "chat.completion", created: 1, model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    }
    const marker = [...heldMarkers].find(([value, kind]) => entry.kind === kind && input.includes(value))?.[0]
    if (marker || (holdPending && !detection && input.includes("Pending response across extension reload"))) {
      entry.held = true
      heldResponses.push({ entry, reply })
    }
    else {
      reply()
    }
  })().catch((error) => {
    recordFailure("HTTP fixture", error)
    if (!res.headersSent)
      res.writeHead(500, { "content-type": "text/plain" })
    res.end("E2E fixture failed")
  })
})

function releaseHeld(marker, status = 200) {
  const selected = heldResponses.filter(response => response.entry.input.includes(marker))
  assert.ok(selected.length > 0, `Expected a held request for ${marker}`)
  heldMarkers.delete(marker)
  for (const response of selected) {
    heldResponses.splice(heldResponses.indexOf(response), 1)
    response.reply(status)
  }
  return selected.map(response => response.entry)
}

async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}

async function check(name, action) {
  if (selectedCase && name !== selectedCase && name !== "chrome-extension-error-list-empty")
    return
  const start = Date.now()
  try {
    await action()
    cases.push({ name, result: "passed", durationMs: Date.now() - start })
    process.stdout.write(`${name}: passed\n`)
  }
  catch (error) {
    cases.push({ name, result: "failed", durationMs: Date.now() - start, message: error.message })
    throw error
  }
}

async function nodeGesture(page, selector) {
  await page.bringToFront()
  await page.locator(selector).hover()
  await page.keyboard.down("Control")
  await page.waitForTimeout(80)
  await page.keyboard.up("Control")
}

async function hasTranslation(page, text) {
  return await page.locator(".vibe-reading-translated-content-wrapper").filter({ hasText: `[E2E translated] ${text}` }).count() > 0
}

try {
  await captureSourceAndBuild()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  context = await chromium.launchPersistentContext("", {
    ...(browserExecutable ? { executablePath: browserExecutable } : { channel: "chromium" }), headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1200, height: 1000 },
  })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  tracingStarted = true
  await context.addInitScript(() => {
    window.e2eInputEvents = []
    for (const type of ["keydown", "keyup", "mouseover", "pointerover"]) {
      document.addEventListener(type, (event) => {
        window.e2eInputEvents.push({ type, key: event.key, repeat: event.repeat, x: event.clientX, y: event.clientY, target: event.target?.id, at: performance.now() })
        if (window.e2eInputEvents.length > 40)
          window.e2eInputEvents.shift()
      })
    }
  })
  context.on("weberror", error => errors.push({ atMs: Date.now() - started, message: error.error().message, stack: error.error().stack }))
  assert.ok(manifest.key, "the production manifest must include this project's configured extension key")
  extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  const isExtensionWorker = (candidate) => {
    const url = new URL(candidate.url())
    return url.protocol === "chrome-extension:" && url.host === extensionId && url.pathname === `/${manifest.background.service_worker}`
  }
  await until(() => context.serviceWorkers().some(isExtensionWorker), "the loaded production extension worker")
  let worker = context.serviceWorkers().find(isExtensionWorker)
  browserVersion = context.browser().version()
  const setupPage = await context.newPage()
  await setupPage.goto("chrome://extensions/")
  await setupPage.evaluate(async (id) => {
    await globalThis.chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })
    await globalThis.chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true })
    const info = await globalThis.chrome.developerPrivate.getExtensionInfo(id)
    if (!info.errorCollection.isActive)
      throw new Error("Chrome extension error collection must be active during acceptance")
  }, extensionId)
  await setupPage.close()

  // Seed a disposable browser profile through the real extension storage API.
  // No user profile or production credentials are imported.
  await until(async () => await worker.evaluate(async () => !!(await globalThis.chrome.storage.local.get("config")).config), "initial config")
  await worker.evaluate(async ({ baseURL, mode }) => {
    const { config } = await globalThis.chrome.storage.local.get("config")
    config.providersConfig = [{
      id: "e2e-local", provider: "openai-compatible", name: "E2E local endpoint", enabled: true,
      apiKey: "e2e-local-only", baseURL,
      model: { model: "use-custom-model", isCustomModel: true, customModel: "fixture-model" },
    }]
    config.language.sourceCode = "eng"
    config.translate.providerId = "e2e-local"
    config.translate.mode = mode
    config.translate.node = { enabled: true, hotkey: "control" }
    config.translate.enableAIContentAware = false
    await globalThis.chrome.storage.local.set({ config })
  }, { baseURL: `${origin}/v1`, mode: translationMode })

  const page = await context.newPage()
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.bringToFront()
  const cdp = await context.newCDPSession(page)
  const worlds = new Map()
  cdp.on("Runtime.executionContextCreated", ({ context: world }) => worlds.set(world.id, world))
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => worlds.delete(executionContextId))
  cdp.on("Runtime.executionContextsCleared", () => worlds.clear())
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const entry = { description: exceptionDetails.exception?.description, details: [] }
    browserExceptions.push(entry)
    const capture = (async () => {
      if (!exceptionDetails.exception?.objectId)
        return
      const properties = await cdp.send("Runtime.getProperties", { objectId: exceptionDetails.exception.objectId, ownProperties: true })
      const nestedErrors = properties.result.find(property => property.name === "errors")?.value?.objectId
      if (nestedErrors) {
        const nested = await cdp.send("Runtime.getProperties", { objectId: nestedErrors, ownProperties: true })
        entry.details = nested.result.filter(property => /^\d+$/.test(property.name)).map(property => property.value?.description)
      }
    })().catch(error => recordFailure("CDP exception details", error))
    pendingDiagnostics.add(capture)
    void capture.finally(() => pendingDiagnostics.delete(capture))
  })
  await cdp.send("Runtime.enable")
  const versions = new Map()
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
    for (const version of updates) {
      versions.set(version.versionId, version)
      if (version.scriptURL === worker.url()) {
        lifecycleEvents.push({ name: "worker-status", atMs: Date.now() - started, versionId: version.versionId, runningStatus: version.runningStatus })
      }
    }
  })
  await cdp.send("ServiceWorker.enable")

  async function extensionWorker() {
    await until(() => context.serviceWorkers().some(item => new URL(item.url()).host === extensionId), "extension worker available")
    return context.serviceWorkers().find(item => new URL(item.url()).host === extensionId)
  }

  async function contentWorld() {
    let found
    const mainFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id
    await until(async () => {
      for (const world of worlds.values()) {
        if (world.auxData?.isDefault || world.auxData?.frameId !== mainFrameId)
          continue
        const result = await cdp.send("Runtime.evaluate", {
          contextId: world.id, expression: "globalThis.chrome?.runtime?.id", returnByValue: true,
        })
        if (result.result.value === extensionId) {
          found = world.id
          return true
        }
      }
      return false
    }, "the loaded extension's content-script world")
    return found
  }

  async function inContentWorld(expression) {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: await contentWorld(), expression, awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  let messageId = 1_000_000
  async function publicMessage(type, data) {
    const message = { id: messageId++, type, data, timestamp: Date.now() }
    return inContentWorld(`(async () => {
      const response = await globalThis.chrome.runtime.sendMessage(${JSON.stringify(message)});
      if (!response || response.err) throw new Error(response?.err?.message ?? "No response");
      return response.res;
    })()`)
  }

  async function waitForLanguage(code) {
    const currentWorker = await extensionWorker()
    const tabId = await currentWorker.evaluate(async (url) => {
      const tabs = await globalThis.chrome.tabs.query({})
      const tab = tabs.find(item => item.url === url)
      if (!tab)
        throw new Error(`No extension tab found for ${url}`)
      return tab.id
    }, page.url())
    await until(async () => await currentWorker.evaluate(async ({ id, expected }) => {
      const key = `detectedCode.${id}`
      return (await globalThis.chrome.storage.session.get(key))[key] === expected
    }, { id: tabId, expected: code }), `page language ${code} reported to real session storage`)
    assert.equal(await publicMessage("getDetectedCode"), code, "the public message must acknowledge the reported page language")
  }

  async function observePublicMessages() {
    await inContentWorld(`(() => {
      if (globalThis.__E2E_CHROME_BOUNDARY__) return;
      const state = globalThis.__E2E_CHROME_BOUNDARY__ = { messages: [], heldDetected: [], delayDetected: false, frames: [], delayFrames: false };
      const send = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime);
      const frame = requestAnimationFrame.bind(globalThis);
      globalThis.chrome.runtime.sendMessage = function (...args) {
        const message = args.find(value => value && typeof value === "object" && typeof value.type === "string");
        const entry = { type: message?.type, id: message?.id, text: message?.data?.text ?? message?.data?.prompt, url: message?.data?.url, startedAt: Date.now(), settled: false };
        state.messages.push(entry);
        const callback = typeof args.at(-1) === "function" ? args.at(-1) : null;
        const forward = () => {
          entry.forwardedAt = Date.now();
          if (callback) {
            const forwarded = [...args];
            forwarded[forwarded.length - 1] = (...values) => {
              entry.settled = true;
              entry.completedAt = Date.now();
              return callback(...values);
            };
            return send(...forwarded);
          }
          return send(...args).then(value => {
            entry.settled = true;
            entry.completedAt = Date.now();
            return value;
          }, error => {
            entry.settled = true;
            entry.completedAt = Date.now();
            entry.error = error.message;
            throw error;
          });
        };
        if (state.delayDetected && message?.type === "getDetectedCode") {
          entry.delayed = true;
          if (callback) {
            state.heldDetected.push(forward);
            return;
          }
          return new Promise((resolve, reject) => state.heldDetected.push(() => forward().then(resolve, reject)));
        }
        return forward();
      };
      globalThis.__E2E_RELEASE_DETECTED__ = () => {
        state.delayDetected = false;
        for (const forward of state.heldDetected.splice(0)) forward();
      };
      globalThis.__E2E_PAUSE_FRAMES__ = () => {
        state.delayFrames = true;
        globalThis.requestAnimationFrame = callback => frame(time => {
          if (state.delayFrames) state.frames.push(callback);
          else callback(time);
        });
      };
      globalThis.__E2E_RELEASE_FRAMES__ = () => {
        state.delayFrames = false;
        globalThis.requestAnimationFrame = frame;
        for (const callback of state.frames.splice(0)) frame(callback);
      };
    })()`)
  }

  async function waitForMessageResult(type, text) {
    await until(async () => await inContentWorld(`(() => {
      const messages = globalThis.__E2E_CHROME_BOUNDARY__.messages.filter(message => message.type === ${JSON.stringify(type)} && message.text?.includes(${JSON.stringify(text)}));
      return messages.length > 0 && messages.every(message => message.settled);
    })()`), `real ${type} response for ${text}`)
    await inContentWorld("new Promise(resolve => setTimeout(resolve, 0))")
  }

  async function recordMessages(name) {
    const messages = await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__?.messages")
    if (messages)
      messageRecords.push({ name, messages })
  }

  captureFailureState = async () => {
    const state = await page.evaluate(() => ({ url: location.href, title: document.title, inputEvents: window.e2eInputEvents, body: document.body.innerHTML }))
    await writeFile(path.join(outputPath, "failure-state.json"), JSON.stringify(state, null, 2))
    await recordMessages("failure")
  }

  async function originalDom(selector) {
    return page.locator(selector).evaluate((element) => {
      const clone = element.cloneNode(true)
      for (const node of [clone, ...clone.querySelectorAll("*")]) {
        for (const attribute of [...node.attributes]) {
          if (attribute.name.startsWith("data-vibe-reading-"))
            node.removeAttribute(attribute.name)
        }
      }
      return clone.innerHTML
    })
  }

  async function reloadExtension() {
    worker = await extensionWorker()
    try {
      await worker.evaluate(() => globalThis.chrome.runtime.reload())
    }
    catch (error) {
      if (!/closed|destroyed|restarted/i.test(error.message))
        throw error
    }
  }

  await page.goto(`${origin}/article`)
  await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "content-script bootstrap")
  await until(() => requests.some(request => request.kind === "language"), "initial language detection")
  await waitForLanguage("eng")

  await check(baseline ? "baseline-first-request-lost" : "cold-background-first-request", async () => {
    await until(() => [...versions.values()].some(version => version.scriptURL === worker.url() && version.runningStatus === "running"), "running extension worker")
    const version = [...versions.values()].find(item => item.scriptURL === worker.url() && item.runningStatus === "running")
    lifecycleEvents.push({ name: "worker-stop-requested", atMs: Date.now() - started, versionId: version.versionId })
    await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId })
    await until(() => versions.get(version.versionId)?.runningStatus === "stopped", "worker stopped")
    const stoppedAtMs = Date.now() - started
    lifecycleEvents.push({ name: "worker-stopped-confirmed", atMs: stoppedAtMs, versionId: version.versionId })
    const beforeWakeup = requests.length
    assert.equal(versions.get(version.versionId)?.runningStatus, "stopped", "the worker must still be stopped immediately before the reader gesture")
    lifecycleEvents.push({ name: "cold-node-gesture", atMs: Date.now() - started })
    await nodeGesture(page, "#p1")
    if (baseline) {
      await until(async () => await page.locator(".vibe-reading-translation-error-container").count() > 0, "baseline missing response error")
      const error = page.locator(".vibe-reading-translation-error-container").first()
      await error.locator("svg").last().hover()
      await until(async () => await page.getByText("No response", { exact: true }).isVisible(), "baseline No response")
      await page.screenshot({ path: path.join(outputPath, "cold-background.png") })
      await error.locator("button").click()
    }
    await until(() => hasTranslation(page, "A reader revisits"), "first node translation")
    await until(() => lifecycleEvents.some(event => event.name === "worker-status" && event.runningStatus === "running" && event.atMs >= stoppedAtMs), "worker restarted after the gesture")
    const firstRequest = requests.slice(beforeWakeup).find(request => request.kind === "translation")
    assert.ok(firstRequest && firstRequest.atMs >= stoppedAtMs, "the first HTTP translation must occur after a confirmed worker stop")
    lifecycleEvents.push({ name: "first-cold-http-translation", atMs: firstRequest.atMs, requestId: firstRequest.id })
    await page.screenshot({ path: path.join(outputPath, "node-translated.png") })
  })

  await check("provider-failure-and-retry", async () => {
    providerStatus = 401
    await nodeGesture(page, "#p2")
    await until(async () => await page.locator(".vibe-reading-translation-error-container").count() > 0, "provider error UI")
    assert.match(await page.locator("#p2").textContent(), /The provider can fail temporarily/)
    await page.screenshot({ path: path.join(outputPath, "provider-failure.png") })
    providerStatus = 200
    await page.locator(".vibe-reading-translation-error-container button").first().click()
    await until(() => hasTranslation(page, "The provider can fail temporarily"), "retry succeeds")
    assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0)
    assert.ok(await hasTranslation(page, "A reader revisits"), "retry must retain the adjacent successful translation")
    await nodeGesture(page, "#p2")
    await until(async () => (await page.locator("#p2").textContent()).trim() === "The provider can fail temporarily and a reader can retry without losing the original paragraph.", "toggle restores original paragraph")
    assert.ok(await hasTranslation(page, "A reader revisits"), "restoring one paragraph must retain its neighbor")
  })

  await check("page-translation-dynamic-content-and-spa", async () => {
    await page.keyboard.press("Alt+KeyE")
    await until(async () => (await page.title()).startsWith("[E2E translated]"), "translated title")
    await until(() => hasTranslation(page, "Page translation also follows"), "full page translation")
    await page.locator("#add").click()
    await until(() => hasTranslation(page, "Dynamic paragraph 1"), "dynamic paragraph translated")
    await page.locator("#route").click()
    await until(() => hasTranslation(page, "A different route"), "SPA translation restarted")
    await until(async () => (await page.title()) === "[E2E translated] Second Route Article", "SPA title translated")
    await page.screenshot({ path: path.join(outputPath, "spa-translated.png") })
  })

  await check(baseline ? "baseline-stale-script-error" : "reload-in-flight-and-old-page-cleanup", async () => {
    holdPending = true
    await page.locator("#pending").click()
    await until(() => heldResponses.length > 0, "in-flight provider request")
    const errorCountBeforeReload = errors.length
    await reloadExtension()
    await page.waitForTimeout(1200)
    holdPending = false
    for (const response of heldResponses.splice(0))
      response.reply()
    await page.locator("#route-paragraph").click()
    await page.keyboard.press("Control")
    await page.locator("#add").click()
    await page.waitForTimeout(300)
    const reloadErrors = errors.slice(errorCountBeforeReload)
    if (baseline) {
      assert.ok(reloadErrors.some(error => /context invalidated/i.test(error.message)), "old release must reproduce stale context errors")
    }
    else {
      assert.deepEqual(reloadErrors, [], "old page must not produce unhandled exceptions")
      assert.equal(await page.locator("[data-vibe-reading-host-toast]").count(), 0, "old React root must be unmounted")
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "translated wrappers must be removed")
      assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0, "late response must not mount stale error UI")
      assert.equal(await page.title(), "Second Route Article", "source title must be restored")
    }
    await page.screenshot({ path: path.join(outputPath, "after-extension-reload.png") })
  })

  await check("page-reload-recovers-translation", async () => {
    const languageReads = requests.filter(request => request.kind === "language").length
    await page.reload()
    await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh content script")
    // Chrome clears session storage when the extension is reloaded. The reader
    // explicitly turns page translation back on in the refreshed document.
    await until(() => requests.filter(request => request.kind === "language").length > languageReads, "fresh language detection")
    await waitForLanguage("eng")
    await page.keyboard.press("Alt+KeyE")
    await until(() => hasTranslation(page, "Page translation also follows"), "new page session after reload")
    await page.screenshot({ path: path.join(outputPath, "recovered.png") })
  })

  if (!baseline) {
    await check("silent-extension-reload-without-page-interaction", async () => {
      await waitForLanguage("eng")
      await until(async () => await page.locator(".vibe-reading-spinner").count() === 0, "all translations completed before quiet reload")
      await until(async () => (await page.title()).startsWith("[E2E translated]"), "title translation completed before quiet reload")
      assert.equal(heldResponses.length, 0, "quiet reload must have no held HTTP response")
      const errorCount = errors.length
      await reloadExtension()
      // Only read the DOM here. No click, key, content mutation, extension API
      // call in the old page or pending response may trigger its cleanup.
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "idle old host automatically unmounted", 5000)
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "idle old translated DOM automatically restored", 5000)
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "quiet reload must automatically remove translations")
      assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0)
      assert.equal(await page.title(), "Lifecycle Article", "quiet reload must restore the source title")
      await page.screenshot({ path: path.join(outputPath, "silent-reload-cleaned.png") })
      await page.locator("#p1").click()
      await page.keyboard.press("Control")
      await page.locator("#add").click()
      await page.keyboard.press("Alt+KeyE")
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "interacting with an invalidated page must not restart translation")
      assert.deepEqual(errors.slice(errorCount), [], "silent reload and later interaction must produce no browser errors")
    })

    await check("mixed-block-retries-preserve-neighbor-and-original-dom", async () => {
      await page.goto(`${origin}/mixed`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "mixed article content script")
      await waitForLanguage("eng")
      await observePublicMessages()
      const sourceMarkup = await originalDom("#mixed")
      await nodeGesture(page, "#neighbor")
      await until(() => hasTranslation(page, mixedNeighbor), "neighbor translation")
      providerStatus = 401
      await nodeGesture(page, "#mixed-inline")
      await until(async () => await page.locator("#mixed .vibe-reading-translation-error-container").count() === 3, "all three mixed groups display their own provider error")
      assert.equal((await page.locator("#mixed-inline").textContent()).trim(), "with the original inline span preserved.", "failure must retain the inline source element")
      assert.match(await page.locator("#mixed-block").textContent(), /Nested block text must also retry independently/)
      assert.ok(await hasTranslation(page, mixedNeighbor), "all mixed failures must preserve the successful neighboring translation")
      await page.screenshot({ path: path.join(outputPath, "mixed-three-errors.png") })
      providerStatus = 200
      for (let retried = 1; retried <= 3; retried++) {
        await page.locator("#mixed .vibe-reading-translation-error-container button").first().click()
        await until(async () => await page.locator("#mixed .vibe-reading-translation-error-container").count() === 3 - retried, `mixed retry ${retried} removes only its own error`)
        await until(async () => await page.locator("#mixed .vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() === retried, `mixed retry ${retried} retains all completed groups`)
        assert.ok(await hasTranslation(page, mixedNeighbor), `mixed retry ${retried} must retain its successful neighbor`)
      }
      await page.screenshot({ path: path.join(outputPath, "mixed-retries-complete.png") })
      await page.keyboard.press("Alt+KeyE")
      await until(async () => (await page.title()).startsWith("[E2E translated]"), "mixed page translation enabled")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "mixed page translation stopped")
      assert.equal(await originalDom("#mixed"), sourceMarkup, "stopping must restore the original mixed text, inline span, block div and tail")
      assert.equal((await page.locator("#neighbor").textContent()).trim(), mixedNeighbor, "stopping must restore the neighboring source")
      await nodeGesture(page, "#neighbor")
      await until(() => hasTranslation(page, mixedNeighbor), "neighbor can translate again")
      await nodeGesture(page, "#mixed-inline")
      await until(async () => await page.locator("#mixed .vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() === 3, "mixed content can translate again")
      await recordMessages("mixed retries")
      await reloadExtension()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "mixed old host automatically cleaned")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "mixed wrappers removed after reload")
      assert.equal(await originalDom("#mixed"), sourceMarkup, "extension reload must restore the exact mixed source structure")
      assert.equal((await page.locator("#neighbor").textContent()).trim(), mixedNeighbor)
      await page.screenshot({ path: path.join(outputPath, "mixed-reload-restored.png") })
    })

    await check("reload-with-mounted-errors", async () => {
      await page.goto(`${origin}/mixed-errors`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "error article content script")
      await waitForLanguage("eng")
      const sourceMarkup = await originalDom("#mixed")
      providerStatus = 401
      await nodeGesture(page, "#mixed-inline")
      await until(async () => await page.locator("#mixed .vibe-reading-translation-error-container").count() === 3, "three mounted error controls reading configuration and theme")
      await until(async () => await page.locator("#mixed .vibe-reading-translation-error-container button").count() === 3, "all three real retry buttons mounted")
      for (const button of await page.locator("#mixed .vibe-reading-translation-error-container button").all())
        assert.ok(await button.isVisible(), "the error controls must be visible before reload")
      await page.screenshot({ path: path.join(outputPath, "mounted-errors-before-reload.png") })
      const errorCount = errors.length
      await reloadExtension()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 0, "old error article host cleaned")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "all old error roots removed")
      await nodeGesture(page, "#mixed-inline")
      assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "invalidated error controls and gestures must remain inactive")
      assert.equal(await originalDom("#mixed"), sourceMarkup)
      assert.deepEqual(errors.slice(errorCount), [], "error-root cleanup must not leave unhandled storage promises")
      providerStatus = 200
      await page.reload()
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "fresh host after error reload")
      await waitForLanguage("eng")
      await nodeGesture(page, "#mixed-inline")
      await until(async () => await page.locator("#mixed .vibe-reading-translated-content-wrapper").filter({ hasText: "[E2E translated]" }).count() === 3, "all failed groups translate after error reload")
      await page.screenshot({ path: path.join(outputPath, "mounted-errors-recovered.png") })
    })

    for (const scenario of ["stop-success", "stop-failure", "spa-success", "spa-failure"]) {
      await check(`obsolete-http-result-after-${scenario}`, async () => {
        await page.goto(`${origin}/session-${scenario}`)
        await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "pending session content script")
        await waitForLanguage("eng")
        await observePublicMessages()
        const oldText = sessionTexts[scenario]
        const currentText = `Current ${scenario} article source belongs to the reused element and must remain after an obsolete response arrives.`
        const currentMarkup = `<span id="current-source">${currentText}</span>`
        await page.evaluate(() => {
          window.e2eReusedElement = document.querySelector("#reuse")
        })
        heldMarkers.set(oldText, "translation")
        await page.keyboard.press("Alt+KeyE")
        await until(() => heldResponses.some(response => response.entry.input.includes(oldText)), "real pending translation request")
        await until(async () => await page.locator("#reuse .vibe-reading-spinner").count() > 0, "old session wrapper inserted")
        if (scenario.startsWith("stop")) {
          await page.keyboard.press("Alt+KeyE")
          await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false, "page translation disabled through its public state")
          await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "old stopped wrappers cleaned")
          await page.evaluate((markup) => {
            document.querySelector("#reuse").innerHTML = markup
          }, currentMarkup)
        }
        else {
          await page.evaluate(({ markup, name }) => {
            history.pushState({}, "", `/current-${name}`)
            document.querySelector("#reuse").innerHTML = markup
            document.title = `Current ${name} Article`
          }, { markup: currentMarkup, name: scenario })
          await until(() => hasTranslation(page, currentText), "new SPA session translated in the reused element")
        }
        const released = releaseHeld(oldText, scenario.endsWith("failure") ? 401 : 200)
        assert.ok(released.every(request => !request.disconnectedBeforeReply), "normal stop and SPA must retain the real provider connection until its late reply")
        await waitForMessageResult("enqueueTranslateRequest", oldText)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await page.evaluate(() => document.querySelector("#reuse") === window.e2eReusedElement), true, "the site must reuse its original p/div element")
        assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0, "obsolete failures must not mount error controls")
        assert.equal(await hasTranslation(page, oldText), false, "obsolete successes must not mount the old translation")
        if (scenario.startsWith("stop")) {
          assert.equal(await page.locator(".vibe-reading-translated-content-wrapper").count(), 0, "late results must not re-enable a stopped session")
          assert.equal(await originalDom("#reuse"), currentMarkup, "late results must preserve the new source DOM")
          await page.keyboard.press("Alt+KeyE")
          await until(() => hasTranslation(page, currentText), "reused stopped element can translate its current source")
        }
        else {
          assert.ok(await hasTranslation(page, currentText), "late results must preserve the successful current SPA translation")
        }
        await page.keyboard.press("Alt+KeyE")
        await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "current session stopped")
        assert.equal(await originalDom("#reuse"), currentMarkup, "restoration must use the current article instead of an obsolete snapshot")
        await page.screenshot({ path: path.join(outputPath, `${scenario}-current-source.png`) })
        await recordMessages(scenario)
      })
    }

    await check("late-old-completion-cannot-unlock-pending-new-session", async () => {
      await page.goto(`${origin}/session-ownership`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "ownership article content script")
      await waitForLanguage("eng")
      await observePublicMessages()
      const oldText = sessionTexts.ownership
      const currentText = "Current pending owner must remain the only request while an obsolete response finishes in this reused element."
      heldMarkers.set(oldText, "translation")
      heldMarkers.set(currentText, "translation")
      await page.keyboard.press("Alt+KeyE")
      await until(() => heldResponses.some(response => response.entry.input.includes(oldText)), "older owner real HTTP request held")
      await until(async () => await page.locator("#reuse .vibe-reading-spinner").count() > 0, "older owner wrapper inserted")
      await page.evaluate((text) => {
        history.pushState({}, "", "/current-ownership")
        document.querySelector("#reuse").textContent = text
        document.title = "Current Ownership Article"
      }, currentText)
      await until(() => heldResponses.some(response => response.entry.input.includes(currentText)), "new session sends its own request before the old one completes")
      await until(async () => await page.locator("#reuse .vibe-reading-spinner").count() > 0, "new pending owner wrapper inserted")
      releaseHeld(oldText)
      await waitForMessageResult("enqueueTranslateRequest", oldText)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await nodeGesture(page, "#reuse")
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const messages = await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.messages")
      assert.equal(messages.filter(message => message.type === "enqueueTranslateRequest" && message.text === currentText).length, 1, "an old completion must not unlock or duplicate the still-pending current request")
      assert.ok(await page.locator("#reuse .vibe-reading-spinner").count() > 0, "a duplicate gesture must retain the pending current owner's wrapper")
      releaseHeld(currentText)
      await waitForMessageResult("enqueueTranslateRequest", currentText)
      await until(() => hasTranslation(page, currentText), "current owner completes normally")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "ownership session stopped")
      assert.equal(await originalDom("#reuse"), currentText)
      await recordMessages("old completion while new owner is pending")
    })

    await check("stop-before-wrapper-preparation-finishes", async () => {
      await page.goto(`${origin}/pre-wrapper`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "preparation article content script")
      await waitForLanguage("eng")
      await observePublicMessages()
      const currentWorker = await extensionWorker()
      await currentWorker.evaluate(async () => {
        const { config } = await globalThis.chrome.storage.local.get("config")
        config.language.sourceCode = "auto"
        config.translate.page.minWordsPerNode = 1
        await globalThis.chrome.storage.local.set({ config })
      })
      await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.delayDetected = true")
      await page.evaluate(() => {
        window.e2eReusedElement = document.querySelector("#reuse")
      })
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.heldDetected.length >= 3"), "each mixed group waits at the real getDetectedCode message boundary")
      assert.equal(await page.locator("#reuse .vibe-reading-translated-content-wrapper").count(), 0, "the fault must occur before any paragraph wrapper is inserted")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false, "preparing session stopped")
      const currentText = "New preparation source belongs to the same reused block and must survive delayed language messages and later restoration."
      const currentMarkup = `<span id="current-source">${currentText}</span>`
      await page.evaluate((markup) => {
        document.querySelector("#reuse").innerHTML = markup
      }, currentMarkup)
      await inContentWorld("globalThis.__E2E_RELEASE_DETECTED__()")
      await until(async () => await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.messages.filter(message => message.delayed).every(message => message.settled)"), "all delayed messages forwarded to real Chrome and completed")
      await inContentWorld("new Promise(resolve => setTimeout(resolve, 0))")
      assert.equal(await page.evaluate(() => document.querySelector("#reuse") === window.e2eReusedElement), true)
      assert.equal(await page.locator("#reuse .vibe-reading-translated-content-wrapper").count(), 0, "obsolete preparation must not create a wrapper after stop")
      assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0)
      assert.equal(await originalDom("#reuse"), currentMarkup)
      await page.keyboard.press("Alt+KeyE")
      await until(() => hasTranslation(page, currentText), "new source translates after the held preparation is released")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "new preparation session stopped")
      assert.equal(await originalDom("#reuse"), currentMarkup, "aborted preparation must not commit a snapshot that restores the previous article")
      await page.screenshot({ path: path.join(outputPath, "pre-wrapper-current-source.png") })
      await recordMessages("pre-wrapper message delay")
      await currentWorker.evaluate(async () => {
        const { config } = await globalThis.chrome.storage.local.get("config")
        config.language.sourceCode = "eng"
        config.translate.page.minWordsPerNode = 0
        await globalThis.chrome.storage.local.set({ config })
      })
    })

    await check("stop-before-animation-frame-inserts-wrapper", async () => {
      await page.goto(`${origin}/frame-before-insertion`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "paused-frame article content script")
      await waitForLanguage("eng")
      await observePublicMessages()
      const oldMarker = "Held frame source"
      heldMarkers.set(oldMarker, "translation")
      await page.evaluate(() => {
        window.e2eReusedElement = document.querySelector("#reuse")
      })
      await inContentWorld("globalThis.__E2E_PAUSE_FRAMES__()")
      await page.keyboard.press("Alt+KeyE")
      await until(() => heldResponses.some(response => response.entry.input.includes(oldMarker)), "provider request started before wrapper insertion")
      await until(async () => await inContentWorld("globalThis.__E2E_CHROME_BOUNDARY__.frames.length > 0"), "real animation-frame callback held at the browser boundary")
      assert.equal(await page.locator("#reuse .vibe-reading-translated-content-wrapper").count(), 0, "the created wrapper must still be unattached")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false, "paused-frame session stopped")
      const currentText = "New frame source in this same paragraph must be the source restored after its next translation is closed."
      // Keep the same paragraph and direct text owner, so an obsolete snapshot
      // cannot be hidden by a newly inserted child element's separate snapshot.
      const currentMarkup = currentText
      await page.evaluate((markup) => {
        document.querySelector("#reuse").innerHTML = markup
      }, currentMarkup)
      const released = releaseHeld(oldMarker)
      assert.ok(released.every(request => !request.disconnectedBeforeReply), "the held provider response must return over its real connection")
      await waitForMessageResult("enqueueTranslateRequest", oldMarker)
      await inContentWorld("(async () => { globalThis.__E2E_RELEASE_FRAMES__(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()")
      assert.equal(await page.evaluate(() => document.querySelector("#reuse") === window.e2eReusedElement), true)
      assert.equal(await page.locator("#reuse .vibe-reading-translated-content-wrapper").count(), 0)
      assert.equal(await page.locator(".vibe-reading-translation-error-container").count(), 0)
      assert.equal(await originalDom("#reuse"), currentMarkup, "resuming queued DOM operations must retain the current article")
      await page.keyboard.press("Alt+KeyE")
      await until(() => hasTranslation(page, currentText), "new source translates after animation frames resume")
      await page.keyboard.press("Alt+KeyE")
      await until(async () => await page.locator(".vibe-reading-translated-content-wrapper").count() === 0, "current paused-frame paragraph restored")
      assert.equal(await originalDom("#reuse"), currentMarkup, "an unattached old wrapper must not leave a stale restoration snapshot")
      await page.screenshot({ path: path.join(outputPath, "frame-before-insertion-current-source.png") })
      await recordMessages("animation-frame delay")
    })

    await check("spa-language-late-a-result-cannot-overwrite-b", async () => {
      await page.goto(`${origin}/language-base`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, "language article content script")
      await waitForLanguage("eng")
      await observePublicMessages()
      heldMarkers.set("LANG_A_OLD", "language")
      await page.evaluate((text) => {
        history.pushState({}, "", "/language-a")
        document.querySelector("#language-text").textContent = text
        document.title = "Older English Article"
      }, languageTexts.oldA)
      await until(() => heldResponses.some(response => response.entry.kind === "language" && response.entry.input.includes("LANG_A_OLD")), "older A language request held over real HTTP")
      await page.evaluate((text) => {
        history.pushState({}, "", "/language-b")
        document.querySelector("#language-text").textContent = text
        document.title = "当前中文文章"
      }, languageTexts.chineseB)
      await until(() => requests.some(request => request.kind === "language" && request.input.includes("LANG_B_CURRENT")), "same-tick B navigation sampled the new Chinese body")
      await waitForLanguage("cmn")
      const released = releaseHeld("LANG_A_OLD")
      assert.ok(released.every(request => !request.disconnectedBeforeReply), "older A must still complete its real HTTP connection")
      await waitForMessageResult("backgroundGenerateText", "LANG_A_OLD")
      assert.equal(await publicMessage("getDetectedCode"), "cmn", "late A language must not replace the current B language")
      assert.equal(await page.locator("#language-text").textContent(), languageTexts.chineseB)
      await page.screenshot({ path: path.join(outputPath, "language-current-b.png") })
      await recordMessages("language A then B")
    })

    await check("spa-language-a-b-a-keeps-new-french-a", async () => {
      heldMarkers.set("LANG_ROUNDTRIP_A_OLD", "language")
      await page.evaluate((text) => {
        history.pushState({}, "", "/language-roundtrip-a")
        document.querySelector("#language-text").textContent = text
        document.title = "Older Same Address English Article"
      }, languageTexts.oldRoundtripA)
      await until(() => heldResponses.some(response => response.entry.kind === "language" && response.entry.input.includes("LANG_ROUNDTRIP_A_OLD")), "old roundtrip A language held")
      const beforeB = requests.length
      await page.evaluate((text) => {
        history.pushState({}, "", "/language-roundtrip-b")
        document.querySelector("#language-text").textContent = text
        document.title = "新的中文文章"
      }, languageTexts.chineseB)
      await until(() => requests.slice(beforeB).some(request => request.kind === "language" && request.input.includes("LANG_B_CURRENT")), "roundtrip B samples its updated body")
      await waitForLanguage("cmn")
      await page.evaluate((text) => {
        history.pushState({}, "", "/language-roundtrip-a")
        document.querySelector("#language-text").textContent = text
        document.title = "Nouvel article français"
      }, languageTexts.currentFrenchA)
      await until(() => requests.some(request => request.kind === "language" && request.input.includes("LANG_A_CURRENT_FR")), "current A samples the new French body after pushState in the same tick")
      await waitForLanguage("fra")
      const released = releaseHeld("LANG_ROUNDTRIP_A_OLD")
      assert.ok(released.every(request => !request.disconnectedBeforeReply), "old English A must return over its real connection")
      await waitForMessageResult("backgroundGenerateText", "LANG_ROUNDTRIP_A_OLD")
      assert.equal(await publicMessage("getDetectedCode"), "fra", "an old request for the same URL must not overwrite the new A language")
      assert.equal(await page.locator("#language-text").textContent(), languageTexts.currentFrenchA)
      await page.screenshot({ path: path.join(outputPath, "language-current-french-a.png") })
      await recordMessages("language A then B then new A")
    })
  }

  if (!baseline) {
    const configure = async (patch) => {
      const currentWorker = await extensionWorker()
      await currentWorker.evaluate(async (value) => {
        const { config } = await globalThis.chrome.storage.local.get("config")
        const next = { ...config, ...value, translate: { ...config.translate, ...value.translate }, language: { ...config.language, ...value.language } }
        await globalThis.chrome.storage.local.set({ config: next })
      }, patch)
    }
    const prepareHost = async (name, markup) => {
      providerStatus = 200
      const pageConfig = await (await extensionWorker()).evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config.translate.page)
      await configure({ language: { sourceCode: "eng" }, translate: { mode: translationMode, node: { enabled: true, hotkey: "control" }, page: { ...pageConfig, minWordsPerNode: 0 } } })
      await page.goto(`${origin}/audit-${name}`)
      await until(async () => await page.locator("[data-vibe-reading-host-toast]").count() === 1, `${name} host bootstrap`)
      if (await publicMessage("getEnablePageTranslationFromContentScript")) {
        await page.keyboard.press("Alt+KeyE")
        await until(async () => await publicMessage("getEnablePageTranslationFromContentScript") === false, "previous translation stopped")
      }
      await waitForLanguage("eng")
      await page.evaluate(({ html, title }) => {
        document.querySelector("#article").innerHTML = html
        document.title = title
      }, { html: markup, title: `Audit ${name} Article` })
      await observePublicMessages()
    }
    const setContentStoragePlan = async (plans) => {
      await inContentWorld(`(${installStorageBoundary.toString()})()`)
      await inContentWorld(`globalThis.__E2E_NATIVE_STORAGE__.plans.push(...${JSON.stringify(plans)})`)
    }
    const releaseContentStorage = label => inContentWorld(`globalThis.__E2E_NATIVE_STORAGE__.release(${JSON.stringify(label)})`)
    const setProviderStatus = (status) => {
      providerStatus = status
    }
    const harness = { check, page, context, origin, extensionId, cdp, extensionWorker, configure, prepareHost, until, nodeGesture, hasTranslation, originalDom, waitForLanguage, publicMessage, inContentWorld, observePublicMessages, waitForMessageResult, recordMessages, requests, heldMarkers, heldResponses, releaseHeld, providerResponses, translationMode, outputPath, installStorageBoundary, setContentStoragePlan, releaseContentStorage, setProviderStatus }
    await runContentBoundaryCases(harness)
    await runInputBoundaryCases(harness)
    await runStateBoundaryCases(harness)
    await runUIBoundaryCases(harness)
    await runSettingsBoundaryCases(harness)
    if (selectedCase)
      assert.ok(cases.some(item => item.name === selectedCase), `No applicable acceptance case: ${selectedCase}`)
  }

  await check(baseline ? "baseline-errors-recorded-by-chrome" : "chrome-extension-error-list-empty", async () => {
    const managerPage = await context.newPage()
    await managerPage.goto(`chrome://extensions/?errors=${extensionId}`)
    const info = await managerPage.evaluate(async (id) => {
      const extension = await globalThis.chrome.developerPrivate.getExtensionInfo(id)
      return { version: extension.version, errorCollection: extension.errorCollection, runtimeErrors: extension.runtimeErrors.map(error => ({ message: error.message, source: error.source })) }
    }, extensionId)
    await writeFile(path.join(outputPath, "chrome-errors.json"), JSON.stringify(info, null, 2))
    await managerPage.screenshot({ path: path.join(outputPath, "chrome-extension-errors.png") })
    assert.ok(info.errorCollection.isActive, "an empty list must have error collection enabled")
    assert.equal(info.version, manifest.version, "Chrome must report the exact version from the captured production build")
    if (baseline)
      assert.ok(info.runtimeErrors.some(error => /context invalidated/i.test(error.message)))
    else
      assert.deepEqual(info.runtimeErrors, [])
  })
  if (!baseline)
    assert.deepEqual(errors, [], "E2E must leave no unhandled browser errors")
  await Promise.all([...pendingDiagnostics])
}
catch (error) {
  recordFailure("acceptance", error)
  if (captureFailureState)
    await diagnostic("failure boundary state", captureFailureState)
  const page = context?.pages().find(item => item.url().startsWith(origin))
  if (page) {
    await diagnostic("failure screenshot", () => page.screenshot({ path: path.join(outputPath, "failure.png") }))
  }
}
finally {
  for (const response of heldResponses.splice(0)) {
    await diagnostic("release pending fixture", async () => response.reply())
  }
  if (context) {
    if (failure && extensionId) {
      await diagnostic("failure Chrome error collection", async () => {
        const managerPage = await context.newPage()
        await managerPage.goto(`chrome://extensions/?errors=${extensionId}`)
        const info = await managerPage.evaluate(async (id) => {
          const extension = await globalThis.chrome.developerPrivate.getExtensionInfo(id)
          return { version: extension.version, state: extension.state, errorCollection: extension.errorCollection, runtimeErrors: extension.runtimeErrors }
        }, extensionId)
        await writeFile(path.join(outputPath, "chrome-errors.json"), JSON.stringify(info, null, 2))
        await managerPage.screenshot({ path: path.join(outputPath, "chrome-extension-errors.png") })
      })
    }
    await Promise.all([...pendingDiagnostics])
    if (tracingStarted) {
      await diagnostic("save browser trace", () => context.tracing.stop({ path: path.join(outputPath, "trace.zip") }))
    }
    await diagnostic("close disposable browser", () => context.close())
  }
  await diagnostic("close local fixture", async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
  await Promise.all([...pendingDiagnostics])
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const report = {
    result: failure ? "failed" : baseline ? "known-bugs-reproduced" : "passed", baseline, translationMode, extensionVersion: manifest?.version, extensionId, browserVersion, browserExecutable,
    revision: sourceSnapshot?.revision, diffSha256: sourceSnapshot?.diffSha256,
    scriptSha256: sourceSnapshot?.scriptSha256, sourceSha256: sourceSnapshot?.sourceSha256, buildSha256: sourceSnapshot?.buildSha256,
    backgroundSha256: sourceSnapshot?.backgroundSha256, hostSha256: sourceSnapshot?.hostSha256,
    sourceStatus: sourceSnapshot?.sourceStatus, metadataCapturedAt: sourceSnapshot?.capturedAt,
    command: `${browserExecutable ? `E2E_BROWSER_EXECUTABLE=${quote(browserExecutable)} ` : ""}pnpm e2e:extension ${quote(extensionPath)} ${quote(outputPath)}${baseline ? " --baseline" : ""}${translationMode === "translationOnly" ? " --translation-only" : ""}${selectedCase ? ` --case=${quote(selectedCase)}` : ""}`,
    environment: "Real Chrome/Chromium with the production unpacked extension in a disposable persistent profile; real browser storage, messaging, worker termination/reload and DOM; Playwright focus emulation means native tab visibility is outside this suite",
    dataPrerequisites: "Disposable extension config: English or automatic source, Chinese target, chosen translation mode, Control node gesture and Alt+E page shortcut, local fixture provider only",
    simulatedExternalDependency: "Local OpenAI-compatible HTTP provider with held/error/empty/echo responses; controlled Chrome message, storage reply and animation-frame timing (real APIs forwarded), plus one-shot storage/locale failures at extension-document bootstrap. Config refresh uses an explicitly dispatched visibilitychange entry; native tab activation is unverified. If the native action popup is unavailable to Playwright, the real popup document selects an actual Chrome fixture tab through a declared tabs-query boundary, recorded in settings-boundaries.json. No production credentials or paid API requests",
    cases, errors, browserExceptions, diagnosticFailures, requests, lifecycleEvents, messageRecords, failure: failure?.message,
  }
  try {
    await writeFile(path.join(outputPath, "report.json"), JSON.stringify(report, null, 2))
  }
  catch (error) {
    recordFailure("write acceptance report", error)
  }
}
if (failure)
  process.exitCode = 1
