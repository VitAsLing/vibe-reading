import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export async function runRequestBoundaryCases(h) {
  await h.check("request-timeout-does-not-replay-pending-http-and-manual-retry-recovers", async () => {
    const name = "request-timeout-does-not-replay-pending-http-and-manual-retry-recovers"
    const marker = "TIMEOUT_NO_REPLAY A slow translation must expose its timeout without starting another copy of the pending provider request."
    await h.prepareHost(name, `<p id="request-target">${marker}</p>`)
    h.heldMarkers.set(marker, "translation")
    await h.nodeGesture(h.page, "#request-target")
    const matchingRequests = () => h.requests.filter(request => request.kind === "translation" && request.input.includes(marker))
    await h.until(() => matchingRequests().length === 1, "one translation reaches the real held HTTP provider")
    const selector = "#request-target .vibe-reading-translation-error-container"
    await h.until(async () => {
      assert.equal(matchingRequests().length, 1, "a local waiting deadline must not replay an HTTP request that is still pending")
      return await h.page.locator(selector).count() === 1
    }, "the production 20-second deadline exposes a retryable error to the reader", 24_000)
    await h.page.locator(selector).locator("[data-slot=hover-card-trigger]").hover()
    const failureDetails = h.page.locator("#request-target [data-slot=hover-card-content]")
    await h.until(() => failureDetails.isVisible(), "the reader can inspect the actual timeout message")
    const failedText = await failureDetails.textContent()
    assert.match(failedText, /timed out after 20000ms/i)
    await h.page.screenshot({ path: path.join(h.outputPath, `${name}-timeout.png`) })
    const released = h.releaseHeld(marker)
    assert.ok(released.every(request => !request.disconnectedBeforeReply), "the late successful response must return through the still-live provider connection")
    await h.until(() => matchingRequests().every(request => request.closedAtMs !== undefined), "the old provider response finishes over its real HTTP connection")
    await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await h.hasTranslation(h.page, marker), false, "a late success must not replace the timeout with unconfirmed translation")
    assert.equal(await h.page.locator(selector).count(), 1, "the reader retains the failure and its retry action after the late response")
    await h.page.locator(selector).getByRole("button").click()
    await h.until(() => h.hasTranslation(h.page, marker), "an explicit reader retry recovers through a new real provider request")
    assert.equal(matchingRequests().length, 2, "only the explicit retry starts the second HTTP request; the late result was not cached as success")
    await h.nodeGesture(h.page, "#request-target")
    await h.until(async () => await h.page.locator("#request-target .vibe-reading-translated-content-wrapper").count() === 0, "closing the recovered translation restores the original source")
    assert.equal(await h.originalDom("#request-target"), marker)
    await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify({ failedText, requests: matchingRequests() }, null, 2))
    await h.page.screenshot({ path: path.join(h.outputPath, `${name}-restored.png`) })
  })

  await h.check("request-user-headers-reach-http-and-clearing-recovers", async () => {
    const name = "request-user-headers-reach-http-and-clearing-recovers"
    const marker = "USER_HEADERS_HTTP A configured provider header must reach the actual translation request and disappear after clearing it."
    const worker = await h.extensionWorker()
    const previous = await worker.evaluate(async () => (await globalThis.chrome.storage.local.get("config")).config)
    try {
      const providersConfig = previous.providersConfig.map(provider => provider.id === "e2e-local"
        ? { ...provider, headers: { "X-Acceptance": "actual-user-header", "X-Empty": "" } }
        : provider)
      await h.configure({ providersConfig })
      await h.prepareHost(name, `<p id="request-target">${marker}</p>`)
      await h.nodeGesture(h.page, "#request-target")
      await h.until(() => h.hasTranslation(h.page, marker), "the actual configured provider translates the paragraph")
      const request = h.requests.find(entry => entry.kind === "translation" && entry.input.includes(marker))
      assert.deepEqual(request.testHeaders, { acceptance: "actual-user-header", empty: null })
      await h.nodeGesture(h.page, "#request-target")
      await h.until(async () => await h.page.locator("#request-target .vibe-reading-translated-content-wrapper").count() === 0, "the first header translation closes")
      await h.configure({ providersConfig: previous.providersConfig })
      const nextMarker = `${marker} Cleared headers use a new source paragraph.`
      await h.prepareHost(`${name}-cleared`, `<p id="request-target">${nextMarker}</p>`)
      await h.nodeGesture(h.page, "#request-target")
      await h.until(() => h.hasTranslation(h.page, nextMarker), "the same provider recovers after removing the user header")
      const cleared = h.requests.find(entry => entry.kind === "translation" && entry.input.includes(nextMarker))
      assert.deepEqual(cleared.testHeaders, { acceptance: null, empty: null })
      await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify({ configured: request.testHeaders, cleared: cleared.testHeaders }, null, 2))
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}.png`) })
    }
    finally {
      await h.configure(previous)
    }
  })
}
