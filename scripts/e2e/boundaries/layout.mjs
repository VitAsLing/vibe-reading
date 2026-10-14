import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export async function runLayoutBoundaryCases(h) {
  await h.check("layout-floated-text-translates-restores-and-reloads", async () => {
    const name = "layout-floated-text-translates-restores-and-reloads"
    const floatText = "Floating text must remain readable and receive its own translation before the reader restores the original article."
    const neighborText = "The neighboring paragraph must also translate without losing its content or changing the original floating layout."
    const variants = [
      { id: "right-inline", direction: "right", markup: `<span id="floated" style="float:right;width:260px">${floatText}</span><span>${neighborText}</span>`, texts: [floatText, neighborText] },
      { id: "left-alone", direction: "left", markup: `<span id="floated" style="float:left;width:260px">${floatText}</span>`, texts: [floatText] },
      { id: "left-block", direction: "left", markup: `<span id="floated" style="float:left;width:260px">${floatText}</span><div>${neighborText}</div>`, texts: [floatText, neighborText] },
      { id: "drop-cap", direction: "left", markup: `<span id="floated" style="float:left;font-size:42px">A</span><span>${neighborText}</span>`, texts: [neighborText] },
    ]
    const observations = []
    for (const variant of variants) {
      await h.prepareHost(`${name}-${variant.id}`, `<div id="float-case" style="display:flow-root;min-height:130px">${variant.markup}</div>`)
      await h.page.locator("h1").evaluate(node => node.classList.add("notranslate"))
      const original = await h.originalDom("#float-case")
      const before = await h.page.locator("#floated").evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return { display: style.display, float: style.float, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      assert.equal(before.display, "block", "real Chrome applies CSS float blockification to the inline source span")
      assert.equal(before.float, variant.direction)
      const requestCount = h.requests.length
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(async () => {
        const translated = (await h.page.locator("#float-case .vibe-reading-translated-content-wrapper").allTextContents()).join(" ")
        return translated.includes("[E2E translated]") && variant.texts.every(text => translated.includes(text))
      }, `${variant.id} renders all floated and neighboring source text through the actual provider`)
      if (variant.id !== "drop-cap") {
        const translatedFloat = h.page.locator("#floated .vibe-reading-translated-content-wrapper")
        assert.ok((await translatedFloat.allTextContents()).join(" ").includes(floatText), "the translated floating block stays in its own column instead of merging with neighboring inline text")
        const textBounds = await translatedFloat.evaluateAll(elements => elements.flatMap((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          return [...range.getClientRects()].map(rect => ({ x: rect.x, width: rect.width }))
        }))
        assert.ok(textBounds.length > 0 && textBounds.every(bounds => bounds.x >= before.x - 1
          && bounds.x + bounds.width <= before.x + before.width + 1), "the rendered translated text remains within the original floating column")
      }
      assert.ok(h.requests.slice(requestCount).some(request => request.kind === "translation" && request.input.includes(variant.texts[0])), "translation reaches the real HTTP provider")
      assert.equal(await h.page.locator("#float-case .vibe-reading-translation-error-container").count(), 0)
      await h.page.screenshot({ path: path.join(h.outputPath, `${name}-${variant.id}-translated.png`) })
      await h.page.keyboard.press("Alt+KeyE")
      await h.until(async () => await h.publicMessage("getEnablePageTranslationFromContentScript") === false
        && await h.page.locator("#float-case .vibe-reading-translated-content-wrapper").count() === 0, "the reader stops translation and restores the floating source")
      assert.equal(await h.originalDom("#float-case"), original, "stopping preserves the original inline and block markup")
      const after = await h.page.locator("#floated").evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      for (const key of ["x", "y", "width", "height"])
        assert.ok(Math.abs(before[key] - after[key]) < 1, `restoring the source preserves its ${key} geometry`)
      observations.push({ variant: variant.id, mode: h.translationMode, before, restored: after, original })
    }
    await h.page.reload()
    await h.until(async () => await h.page.locator("[data-vibe-reading-host-toast]").count() === 1, "a real page reload recovers the content entrypoint after all floating workflows")
    assert.equal(await h.publicMessage("getEnablePageTranslationFromContentScript"), false, "a stopped page stays stopped after reload")
    await h.nodeGesture(h.page, "#p1")
    await h.until(() => h.hasTranslation(h.page, "A reader revisits"), "a fresh paragraph gesture translates after reload")
    await writeFile(path.join(h.outputPath, `${name}.json`), JSON.stringify(observations, null, 2))
  })
}
