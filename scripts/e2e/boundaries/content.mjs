import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const wrapperSelector = ".vibe-reading-translated-content-wrapper"
const errorSelector = ".vibe-reading-translation-error-container"
const reactHostSelector = ".vibe-reading-react-shadow-host"
const targetSelector = "#content-target"

async function frames(h) {
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function begin(h, entry) {
  if (entry === "manual") {
    await h.nodeGesture(h.page, targetSelector)
  }
  else {
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === true, "page translation enabled through the real public state")
  }
}

async function heldParagraph(h, name, entry, oldText, markup = `<p id="content-target">${oldText}</p>`) {
  await h.prepareHost(name, markup)
  // The controlled HTTP failure applies to a whole provider batch. Exclude
  // the fixture heading so its legitimate failure cannot masquerade as a
  // stale paragraph result; keep the assertion over all visible error roots.
  await h.page.locator("h1").evaluate(node => node.classList.add("notranslate"))
  h.heldMarkers.set(oldText, "translation")
  await begin(h, entry)
  await h.until(() => h.heldResponses.some(response => response.entry.kind === "translation" && response.entry.input.includes(oldText)), `${name} reaches the real held provider request`)
  await h.until(async () => await h.page.locator(`${targetSelector} .vibe-reading-spinner`).count() === 1, `${name} source wrapper is visibly inserted`)
  await h.page.evaluate(({ target, wrapper }) => {
    const element = document.querySelector(target)
    window.e2eContentRefs = { target: element, text: element.firstChild, wrapper: element.querySelector(wrapper) }
  }, { target: targetSelector, wrapper: wrapperSelector })
}

async function currentRequested(h, text) {
  return h.requests.some(request => request.kind === "translation" && request.input.includes(text))
    || await h.inContentWorld(`globalThis.__E2E_CHROME_BOUNDARY__.messages.some(message => message.type === "enqueueTranslateRequest" && message.text?.includes(${JSON.stringify(text)}))`)
}

async function translateCurrent(h, text) {
  if (!await h.hasTranslation(h.page, text) && !await currentRequested(h, text)) {
    await h.nodeGesture(h.page, targetSelector)
  }
  await h.until(() => h.hasTranslation(h.page, text), "the current source translates independently of the obsolete request")
}

async function finishOld(h, oldText, status) {
  const released = h.releaseHeld(oldText, status)
  assert.ok(released.every(request => !request.disconnectedBeforeReply), "the old result must finish over its real provider connection")
  await h.waitForMessageResult("enqueueTranslateRequest", oldText)
  await frames(h)
}

async function closeCurrent(h, text) {
  if (await h.publicMessage("getEnablePageTranslationFromContentScript")) {
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false, "page translation disabled through the real public state")
  }
  else if (await h.hasTranslation(h.page, text)) {
    await h.nodeGesture(h.page, targetSelector)
  }
  await h.until(async () => await h.page.locator(`${targetSelector} ${wrapperSelector}`).count() === 0, "closing translation removes the current paragraph wrappers")
  await frames(h)
}

async function evidence(h, name, phase) {
  const state = await h.page.evaluate(({ target, error, reactHost }) => {
    const element = document.querySelector(target)
    const refs = window.e2eContentRefs
    return {
      url: location.href,
      title: document.title,
      currentMarkup: element?.innerHTML ?? null,
      currentText: element?.textContent ?? null,
      sameTarget: refs ? refs.target === element : null,
      oldTargetConnected: refs?.target?.isConnected ?? null,
      oldWrapperConnected: refs?.wrapper?.isConnected ?? null,
      oldWrapperText: refs?.wrapper?.textContent ?? null,
      oldErrorRoots: refs?.wrapper?.querySelectorAll(error).length ?? null,
      oldReactHosts: refs?.wrapper?.querySelectorAll(reactHost).length ?? null,
      oldSourceText: refs?.text?.data ?? null,
      oldIdentitySourceConnected: refs?.oldIdentitySource?.isConnected ?? null,
      newIdentitySourceConnected: refs?.newIdentitySource?.isConnected ?? null,
    }
  }, { target: targetSelector, error: errorSelector, reactHost: reactHostSelector })
  const artifact = `${name}-${phase}`
  await writeFile(path.join(h.outputPath, `${artifact}.json`), JSON.stringify(state, null, 2))
  await h.page.screenshot({ path: path.join(h.outputPath, `${artifact}.png`) })
  await h.recordMessages(artifact)
  return state
}

function assertNoDetachedUI(state) {
  assert.equal(state.oldErrorRoots, 0, "an obsolete wrapper must not retain an error component even outside the document")
  assert.equal(state.oldReactHosts, 0, "an obsolete wrapper must not retain a mounted React host")
}

async function mutateSource(h, kind, text) {
  const mutation = await h.page.evaluate(({ kind: change, currentText }) => {
    const refs = window.e2eContentRefs
    const element = document.querySelector("#content-target")
    if (change === "text") {
      if (refs.text.nodeType !== Node.TEXT_NODE)
        throw new Error("The preservation fixture requires the original direct Text node")
      refs.text.data = currentText
    }
    else if (change === "content") {
      element.textContent = currentText
    }
    else {
      const replacement = document.createElement("p")
      replacement.id = "content-target"
      replacement.textContent = currentText
      element.replaceWith(replacement)
    }
    return {
      sameTarget: document.querySelector("#content-target") === refs.target,
      sameText: document.querySelector("#content-target").firstChild === refs.text,
      oldWrapperStillPresent: refs.target.contains(refs.wrapper),
    }
  }, { kind, currentText: text })
  assert.equal(mutation.sameTarget, kind !== "element", "the fixture must change only the intended element identity")
  if (kind === "text") {
    assert.equal(mutation.sameText, true, "text mutation must retain the actual original Text node")
    assert.equal(mutation.oldWrapperStillPresent, true, "text mutation must retain the old wrapper at the mutation boundary")
  }
  await frames(h)
}

async function sameURLCase(h, name, entry, kind, status) {
  const oldText = `Old ${name} source remains held while the website updates the paragraph without changing its address.`
  const currentText = `Current ${name} source must translate before the old request finishes and must survive later restoration.`
  await heldParagraph(h, name, entry, oldText)
  const originalURL = h.page.url()
  await mutateSource(h, kind, currentText)
  assert.equal(h.page.url(), originalURL, "the scenario must exercise a DOM update without any URL navigation")
  await evidence(h, name, "source-updated-old-http-held")
  await translateCurrent(h, currentText)
  assert.ok(h.heldResponses.some(response => response.entry.input.includes(oldText)), "the current translation must complete before the obsolete HTTP response is released")
  await finishOld(h, oldText, status)
  const state = await evidence(h, name, "late-response")
  assert.equal(state.sameTarget, kind !== "element")
  assert.equal(await h.hasTranslation(h.page, oldText), false, "a late old success must not appear in the current article")
  assert.equal(await h.hasTranslation(h.page, currentText), true, "a late old result must retain the completed current translation")
  assert.equal(await h.page.locator(errorSelector).count(), 0, "a late old failure must not mount a visible error component")
  assertNoDetachedUI(state)
  assert.equal(state.oldWrapperText.includes(`[E2E translated] ${oldText}`), false, "an obsolete result must not render in the saved old wrapper outside the document")
  await closeCurrent(h, currentText)
  await evidence(h, name, "current-source-restored")
  assert.equal(await h.originalDom(targetSelector), currentText, "closing must restore the current source, not an obsolete snapshot")
}

async function sameMarkupReplacementCase(h, name, kind) {
  const marker = `Unchanged ${name} paragraph supplies the same readable source before and after the website recreates its nodes.`
  const sourceMarkup = kind === "span"
    ? `${marker}<span id="content-inline"> The website owns this unchanged inline span.</span> The final source also remains unchanged.`
    : marker
  await heldParagraph(h, name, "manual", marker, `<p id="content-target">${sourceMarkup}</p>`)
  const originalURL = h.page.url()
  const mutation = await h.page.evaluate((replacementKind) => {
    const refs = window.e2eContentRefs
    const owner = refs.target
    const before = owner.innerHTML
    const oldSource = replacementKind === "span" ? owner.querySelector("#content-inline") : owner.firstChild
    if (!oldSource || (replacementKind === "text" && oldSource.nodeType !== Node.TEXT_NODE))
      throw new Error("The identity fixture requires its original source node")
    const newSource = oldSource.cloneNode(true)
    oldSource.replaceWith(newSource)
    refs.oldIdentitySource = oldSource
    refs.newIdentitySource = newSource
    return {
      sameTarget: owner === document.querySelector("#content-target"),
      sameMarkup: before === owner.innerHTML,
      differentSource: oldSource !== newSource,
      oldSourceConnected: oldSource.isConnected,
      newSourceConnected: newSource.isConnected,
      newSourceBelongsToOwner: owner.contains(newSource),
      oldWrapperStillPresent: owner.contains(refs.wrapper),
    }
  }, kind)
  await writeFile(path.join(h.outputPath, `${name}-identity-replaced.json`), JSON.stringify(mutation, null, 2))
  assert.equal(h.page.url(), originalURL, "identity replacement must not navigate")
  assert.equal(mutation.sameTarget, true, "identity replacement must reuse the exact paragraph")
  assert.equal(mutation.sameMarkup, true, "the website must recreate the source without any HTML or text difference")
  assert.equal(mutation.differentSource, true, "the website must supply a different actual source node")
  assert.equal(mutation.oldSourceConnected, false)
  assert.equal(mutation.newSourceConnected, true)
  assert.equal(mutation.newSourceBelongsToOwner, true)
  assert.equal(mutation.oldWrapperStillPresent, true, "the website must preserve the pending wrapper at the replacement boundary")
  await frames(h)
  const replaced = await evidence(h, name, "same-markup-old-http-held")
  assert.ok(h.heldResponses.some(response => response.entry.input.includes(marker)), "source cancellation must occur while the actual provider response is still held")
  assert.equal(replaced.oldWrapperConnected, false, "recreating a source must automatically discard its obsolete wrapper even when its HTML is identical")
  assert.equal(replaced.newIdentitySourceConnected, true, "source cancellation must retain the website's replacement node")
  assert.equal(await h.page.locator(`${targetSelector} ${wrapperSelector}`).count(), 0)
  assertNoDetachedUI(replaced)
  assert.equal(await h.originalDom(targetSelector), sourceMarkup)

  // Finish the obsolete HTTP first: a new same-text request may legitimately
  // share provider work or cache, so it must not stand in for this cancellation.
  await finishOld(h, marker, 200)
  const late = await evidence(h, name, "late-identical-source-response")
  assert.equal(await h.hasTranslation(h.page, marker), false, "the old success must not revive the obsolete source operation")
  assert.equal(await h.page.locator(wrapperSelector).count(), 0)
  assert.equal(late.oldWrapperText.includes(`[E2E translated] ${marker}`), false, "the old result must not render into its saved detached wrapper")
  assert.equal(late.newIdentitySourceConnected, true)
  assertNoDetachedUI(late)

  await h.nodeGesture(h.page, targetSelector)
  await h.until(() => h.hasTranslation(h.page, marker), "a legal new gesture translates the replacement source after its old owner is released")
  await frames(h)
  const translated = await evidence(h, name, "replacement-translated")
  assert.equal(await h.page.locator(`${targetSelector} ${wrapperSelector}`).count(), 1, "the replacement source must translate exactly once")
  assert.equal(await h.page.locator(errorSelector).count(), 0)
  if (h.translationMode === "translationOnly") {
    const sourceOutsideWrapper = await h.page.locator(targetSelector).evaluate((element) => {
      const clone = element.cloneNode(true)
      clone.querySelectorAll(".vibe-reading-translated-content-wrapper").forEach(wrapper => wrapper.remove())
      return clone.textContent.trim()
    })
    assert.equal(sourceOutsideWrapper, "", "translation-only mode must replace the current source rather than display its duplicate beside the translation")
    assert.equal(translated.newIdentitySourceConnected, false, "translation-only mode must replace the website's actual new source node before closing")
  }
  await closeCurrent(h, marker)
  await evidence(h, name, "replacement-source-restored")
  assert.equal(await h.originalDom(targetSelector), sourceMarkup, "closing must restore the replacement paragraph's current source structure")
}

async function detachedFailureCase(h, name, entry, alreadyMounted) {
  const oldText = `Old ${name} paragraph supplies an error result whose React lifecycle must end when the website removes that paragraph.`
  const currentText = `Current ${name} replacement paragraph remains usable after the obsolete paragraph is removed.`
  await heldParagraph(h, name, entry, oldText)
  if (alreadyMounted) {
    await finishOld(h, oldText, 401)
    await h.until(async () => await h.page.locator(`${targetSelector} ${errorSelector}`).count() === 1, "the real provider failure visibly mounts its error component")
    await evidence(h, name, "error-mounted-before-removal")
  }
  await mutateSource(h, "element", currentText)
  if (!alreadyMounted)
    await finishOld(h, oldText, 401)
  await evidence(h, name, "removed-source")
  await h.until(async () => await h.page.evaluate(() => window.e2eContentRefs.wrapper.querySelectorAll(".vibe-reading-react-shadow-host").length === 0), "removing the source must release its detached React error root")
  const state = await evidence(h, name, "detached-root-released")
  assert.equal(state.oldTargetConnected, false, "the website must actually remove the old paragraph")
  assert.equal(state.oldWrapperConnected, false)
  assertNoDetachedUI(state)
  assert.equal(await h.page.locator(errorSelector).count(), 0)
  await translateCurrent(h, currentText)
  await closeCurrent(h, currentText)
  assert.equal(await h.originalDom(targetSelector), currentText)
}

async function manualCancellationCase(h, name, boundary) {
  const oldText = `Old ${name} manual paragraph request must become obsolete when the reader changes the document translation lifecycle.`
  const currentText = `Current ${name} source belongs to the reused paragraph after cancellation of the earlier manual request.`
  await heldParagraph(h, name, "manual", oldText)
  if (boundary === "stop") {
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === true, "page translation started while the manual request is held")
    await h.page.keyboard.press("Alt+KeyE")
    await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false, "the reader stopped page translation")
    await h.until(async () => await h.page.locator(wrapperSelector).count() === 0, "stopping removes the old manual wrapper")
    await mutateSource(h, "content", currentText)
  }
  else {
    await h.page.evaluate(({ url, text }) => {
      history.pushState({}, "", url)
      document.querySelector("#content-target").textContent = text
      document.title = "Current manual route cancellation article"
    }, { url: `/audit-${name}-current`, text: currentText })
    await frames(h)
  }
  await evidence(h, name, "cancelled-old-http-held")
  await translateCurrent(h, currentText)
  assert.ok(h.heldResponses.some(response => response.entry.input.includes(oldText)), "manual cancellation must permit the new request before the old result arrives")
  await finishOld(h, oldText, boundary === "stop" ? 200 : 401)
  const state = await evidence(h, name, "late-response")
  assert.equal(state.sameTarget, true, "the website must reuse the exact paragraph element")
  assertNoDetachedUI(state)
  assert.equal(state.oldWrapperText.includes(`[E2E translated] ${oldText}`), false, "a cancelled manual request must not render into its saved old wrapper")
  assert.equal(await h.hasTranslation(h.page, oldText), false)
  assert.equal(await h.hasTranslation(h.page, currentText), true)
  assert.equal(await h.page.locator(errorSelector).count(), 0)
  await closeCurrent(h, currentText)
  await evidence(h, name, "current-source-restored")
  assert.equal(await h.originalDom(targetSelector), currentText)
}

export async function runContentBoundaryCases(h) {
  for (const entry of ["manual", "page"]) {
    for (const outcome of ["success", "failure"]) {
      const name = `${entry}-same-url-text-mutation-discards-late-${outcome}`
      await h.check(name, () => sameURLCase(h, name, entry, "text", outcome === "success" ? 200 : 401))
    }
    {
      const name = `${entry}-same-url-content-replacement-releases-obsolete-owner`
      await h.check(name, () => sameURLCase(h, name, entry, "content", 200))
    }
    {
      const name = `${entry}-same-url-element-replacement-discards-late-success`
      await h.check(name, () => sameURLCase(h, name, entry, "element", 200))
    }
    {
      const name = `${entry}-detached-paragraph-failure-does-not-mount-react-root`
      await h.check(name, () => detachedFailureCase(h, name, entry, false))
    }
    {
      const name = `${entry}-mounted-error-root-released-after-paragraph-removal`
      await h.check(name, () => detachedFailureCase(h, name, entry, true))
    }
  }

  for (const boundary of ["stop", "route"]) {
    const name = `manual-pending-paragraph-cancelled-by-${boundary === "stop" ? "page-stop" : "route-change"}`
    await h.check(name, () => manualCancellationCase(h, name, boundary))
  }

  for (const kind of ["text", "span"]) {
    const name = `manual-same-markup-${kind}-replacement-discards-obsolete-owner`
    await h.check(name, () => sameMarkupReplacementCase(h, name, kind))
  }

  if (h.translationMode !== "translationOnly")
    return

  await h.check("only-nested-snapshot-restores-current-source", async () => {
    const name = "only-nested-snapshot-restores-current-source"
    const oldText = `Old ${name} nested paragraph must first translate and restore its single inline child correctly.`
    const oldMarkup = `<span id="content-inner">${oldText}</span>`
    const currentText = `Current ${name} direct text must survive translation and closing after the same paragraph changes its child structure.`
    await h.prepareHost(name, `<p id="content-target">${oldMarkup}</p>`)
    await h.nodeGesture(h.page, "#content-inner")
    await h.until(() => h.hasTranslation(h.page, oldText), "the nested original paragraph translates")
    await closeCurrent(h, oldText)
    assert.equal(await h.originalDom(targetSelector), oldMarkup, "the first close must restore the original nested structure")
    await h.page.evaluate((text) => {
      window.e2eContentRefs = { target: document.querySelector("#content-target") }
      document.querySelector("#content-target").textContent = text
    }, currentText)
    await translateCurrent(h, currentText)
    await closeCurrent(h, currentText)
    const state = await evidence(h, name, "current-source-restored")
    assert.equal(state.sameTarget, true)
    assert.equal(await h.originalDom(targetSelector), currentText, "an unused outer snapshot must not restore the obsolete inline child")
  })

  for (const response of ["empty", "echo"]) {
    const name = `only-${response}-response-releases-restoration-snapshot`
    await h.check(name, async () => {
      const oldText = `Old ${name} source has a valid provider response requiring no displayed translation.`
      const currentText = `Current ${name} source must be restored after translating a reused paragraph that previously needed no output.`
      await h.prepareHost(name, `<p id="content-target">${oldText}</p>`)
      h.providerResponses.set(oldText, response)
      try {
        await h.nodeGesture(h.page, targetSelector)
        await h.waitForMessageResult("enqueueTranslateRequest", oldText)
        await frames(h)
        await h.until(async () => await h.page.locator(`${targetSelector} ${wrapperSelector}`).count() === 0, `${response} output removes the unnecessary translation wrapper`)
        assert.equal(await h.page.locator(errorSelector).count(), 0, "valid empty or identical output must not be a provider error")
        assert.equal(await h.originalDom(targetSelector), oldText)
        await evidence(h, name, "no-translation-needed")
      }
      finally {
        h.providerResponses.delete(oldText)
      }
      await h.page.evaluate((text) => {
        window.e2eContentRefs = { target: document.querySelector("#content-target") }
        document.querySelector("#content-target").textContent = text
      }, currentText)
      await translateCurrent(h, currentText)
      await closeCurrent(h, currentText)
      const state = await evidence(h, name, "current-source-restored")
      assert.equal(state.sameTarget, true)
      assert.equal(await h.originalDom(targetSelector), currentText, "removing an unnecessary wrapper must also release its obsolete restoration state")
    })
  }
}
