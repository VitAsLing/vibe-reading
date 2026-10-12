import assert from "node:assert/strict"

export async function runInputBoundaryCases(h) {
  const { check, page, prepareHost, configure, until, nodeGesture, hasTranslation, inContentWorld, requests, recordMessages, setContentStoragePlan, releaseContentStorage } = h
  const wrapper = ".vibe-reading-translated-content-wrapper"
  const errors = ".vibe-reading-translation-error-container"
  const text = (name, number) => `${name} paragraph ${number} belongs to this reader interaction and must only translate after a valid gesture is accepted.`
  // Reserve enough space for bilingual output so the earlier valid action
  // cannot move the next paragraph away from its saved pointer coordinates.
  const paragraphs = name => [1, 2, 3].map(number => `<p id="p${number}" style="height:180px">${text(name, number)}</p>`).join("")
  const frames = () => inContentWorld("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

  async function prepare(name, hotkey = "control", markup = paragraphs(name)) {
    await page.bringToFront()
    await prepareHost(name, markup)
    await configure({ translate: { node: { enabled: true, hotkey } } })
    await frames()
  }

  async function holdConfig(label) {
    await setContentStoragePlan([{ area: "local", method: "get", key: "config", action: "hold", label }])
  }

  async function held(label) {
    await until(async () => await inContentWorld(`(() => {
      const state = globalThis.__E2E_NATIVE_STORAGE__;
      return state.held.some(entry => entry.label === ${JSON.stringify(label)})
        && state.calls.some(call => call.label === ${JSON.stringify(label)} && call.forwarded && !call.settled);
    })()`), `real Chrome configuration response held: ${label}`)
  }

  async function release(label) {
    await releaseContentStorage(label)
    await until(async () => await inContentWorld(`(() => {
      const calls = globalThis.__E2E_NATIVE_STORAGE__.calls.filter(call => call.label === ${JSON.stringify(label)});
      return calls.length > 0 && calls.every(call => call.settled);
    })()`), `real Chrome configuration response delivered: ${label}`)
    await frames()
  }

  async function armMouse(selector, label) {
    await holdConfig(label)
    await page.locator(selector).hover({ position: { x: 12, y: 12 } })
    await page.mouse.down({ button: "left" })
    await held(label)
    await release(label)
  }

  async function armControl(selector, label) {
    await holdConfig(label)
    await page.locator(selector).hover()
    await page.keyboard.down("Control")
    await held(label)
    await release(label)
  }

  async function translatedOnce(selector, expected, label) {
    await until(() => hasTranslation(page, expected), label)
    await frames()
    assert.equal(await page.locator(`${selector} ${wrapper}`).count(), 1, `${label}: one visible translation`)
    assert.equal(await page.locator(errors).count(), 0, `${label}: no error controls`)
  }

  async function noTranslation(selector, before, label) {
    // A cancelled hold must remain inactive beyond its 500 ms recognition
    // period. Inspect wrappers as well as HTTP so a cached/spinning result
    // cannot hide an unwanted input action.
    await page.waitForTimeout(700)
    await frames()
    assert.equal(await page.locator(`${selector} ${wrapper}`).count(), 0, label)
    assert.equal(await page.locator(errors).count(), 0, `${label}: no error controls`)
    assert.equal(requests.slice(before).filter(request => request.kind === "translation").length, 0, `${label}: no provider translation request`)
  }

  async function holdMouseToTranslate(selector, expected) {
    await page.locator(selector).hover({ position: { x: 12, y: 12 } })
    await page.mouse.down({ button: "left" })
    await translatedOnce(selector, expected, "a fresh stationary mouse hold recovers translation")
    await page.mouse.up({ button: "left" })
    await frames()
    assert.equal(await page.locator(`${selector} ${wrapper}`).count(), 1, "mouse release must retain the completed translation")
  }

  async function cleanup(name) {
    await inContentWorld(`(() => {
      const state = globalThis.__E2E_NATIVE_STORAGE__;
      if (!state) return;
      state.plans = state.plans.filter(plan => !plan.label?.startsWith("input-"));
      for (const label of new Set(state.held.filter(entry => entry.label?.startsWith("input-")).map(entry => entry.label))) state.release(label);
    })()`)
    await page.mouse.up({ button: "left" })
    for (const key of ["a", "Control", "Shift", "Alt"])
      await page.keyboard.up(key)
    await frames()
    await recordMessages(name)
  }

  await check("input-mouse-release-before-config", async () => {
    const name = "input-mouse-release-before-config"
    await prepare(name, "clickAndHold")
    try {
      const before = requests.length
      await holdConfig(`${name}-down`)
      await page.locator("#p1").hover({ position: { x: 12, y: 12 } })
      await page.mouse.down({ button: "left" })
      await held(`${name}-down`)
      await page.mouse.up({ button: "left" })
      await release(`${name}-down`)
      await noTranslation("#p1", before, "a released mouse press must not restart when its configuration arrives")
      await holdMouseToTranslate("#p2", text(name, 2))
      assert.equal(await hasTranslation(page, text(name, 1)), false, "recovery must not replay the cancelled first paragraph")
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-mouse-move-before-config", async () => {
    const name = "input-mouse-move-before-config"
    await prepare(name, "clickAndHold")
    try {
      const before = requests.length
      await holdConfig(`${name}-down`)
      await page.locator("#p1").hover({ position: { x: 12, y: 12 } })
      await page.mouse.down({ button: "left" })
      await held(`${name}-down`)
      await page.locator("#p2").hover({ position: { x: 12, y: 12 } })
      await release(`${name}-down`)
      await noTranslation("#article", before, "moving away while configuration is pending must cancel the original mouse hold")
      await page.mouse.up({ button: "left" })
      await holdMouseToTranslate("#p2", text(name, 2))
      assert.equal(await hasTranslation(page, text(name, 1)), false)
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-mouse-inline-crossing-cancels-hold", async () => {
    const name = "input-mouse-inline-crossing-cancels-hold"
    const markup = `<p id="p1">${name} original mouse location. <span id="far-inline" style="margin-left:180px">A distinct inline movement destination.</span></p><p id="p2">${text(name, 2)}</p><p id="p3">${text(name, 3)}</p>`
    await prepare(name, "clickAndHold", markup)
    try {
      const before = requests.length
      await armMouse("#p1", `${name}-down`)
      const originPoint = await page.locator("#p1").boundingBox()
      const destination = await page.locator("#far-inline").boundingBox()
      assert.ok(originPoint && destination, "both movement targets must have real browser geometry")
      assert.ok(Math.hypot(destination.x + destination.width / 2 - originPoint.x - 12, destination.y + destination.height / 2 - originPoint.y - 12) > 6, "the movement must exceed the actual 6 px cancellation tolerance")
      await page.locator("#far-inline").hover()
      await noTranslation("#article", before, "pointerover/mouseover of an inline child must not hide a large movement from hold cancellation")
      await page.mouse.up({ button: "left" })
      await holdMouseToTranslate("#p2", text(name, 2))
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-mouse-release-during-hold-config", async () => {
    const name = "input-mouse-release-during-hold-config"
    await prepare(name, "clickAndHold")
    try {
      const before = requests.length
      await armMouse("#p1", `${name}-down`)
      await holdConfig(`${name}-timer`)
      await held(`${name}-timer`)
      await page.mouse.up({ button: "left" })
      await release(`${name}-timer`)
      await noTranslation("#p1", before, "a released hold timer must not translate or dereference its cleared coordinates")
      await holdMouseToTranslate("#p2", text(name, 2))
      assert.equal(await hasTranslation(page, text(name, 1)), false)
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-keyboard-config-returns-after-release", async () => {
    const name = "input-keyboard-config-returns-after-release"
    await prepare(name)
    try {
      await holdConfig(`${name}-down`)
      await page.locator("#p1").hover()
      await page.keyboard.down("Control")
      await held(`${name}-down`)
      await page.keyboard.up("Control")
      await frames()
      await release(`${name}-down`)
      await translatedOnce("#p1", text(name, 1), "a completed pure short press survives configuration response reordering")
      await page.waitForTimeout(650)
      assert.equal(await page.locator(`#p1 ${wrapper}`).count(), 1, "a late keydown must not repeat a completed press")
      await nodeGesture(page, "#p2")
      await translatedOnce("#p2", text(name, 2), "the next independent short press works on its first attempt")
      assert.equal(await page.locator(`#p1 ${wrapper}`).count(), 1, "the next press must retain its translated neighbor")
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-keyboard-old-keyup-cannot-reset-new-press", async () => {
    const name = "input-keyboard-old-keyup-cannot-reset-new-press"
    await prepare(name)
    try {
      await armControl("#p1", `${name}-down`)
      await holdConfig(`${name}-old-up`)
      await page.keyboard.up("Control")
      await held(`${name}-old-up`)
      await page.locator("#p2").hover()
      await page.keyboard.down("Control")
      await frames()
      await holdConfig(`${name}-new-up`)
      await page.keyboard.up("Control")
      await held(`${name}-new-up`)
      await release(`${name}-old-up`)
      await translatedOnce("#p1", text(name, 1), "the older completed pure press retains its own paragraph identity")
      assert.equal(await page.evaluate(() => {
        const pointer = window.e2eInputEvents.findLast(event => event.type === "mouseover" && event.target === "p2")
        return pointer && document.elementFromPoint(pointer.x, pointer.y)?.closest("p")?.id
      }), "p2", "the second press's coordinates must still point at its intended paragraph")
      assert.equal(await page.locator(`#p2 ${wrapper}`).count(), 0, "an older keyup must not commit the new press while its own real configuration response is still held")
      await release(`${name}-new-up`)
      await translatedOnce("#p2", text(name, 2), "the new pure press survives the older press's late keyup and state cleanup")
      assert.equal(await page.locator(`#p1 ${wrapper}`).count(), 1, "preserving the new press must not discard the older legitimate short press")
      await nodeGesture(page, "#p3")
      await translatedOnce("#p3", text(name, 3), "a further independent press remains usable")
      assert.equal(await page.locator(`#p2 ${wrapper}`).count(), 1)
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-keyboard-combo-cancels-pending-hold", async () => {
    const name = "input-keyboard-combo-cancels-pending-hold"
    await prepare(name)
    try {
      const before = requests.length
      await armControl("#p1", `${name}-down`)
      await holdConfig(`${name}-timer`)
      await held(`${name}-timer`)
      await page.keyboard.down("a")
      await frames()
      await release(`${name}-timer`)
      await noTranslation("#p1", before, "forming a real key combination must cancel a hold already awaiting configuration")
      await page.keyboard.up("a")
      await page.keyboard.up("Control")
      await frames()
      await nodeGesture(page, "#p2")
      await translatedOnce("#p2", text(name, 2), "pure shortcuts recover after the cancelled combination")
      assert.equal(await hasTranslation(page, text(name, 1)), false)
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-keyboard-hotkey-change-cancels-press", async () => {
    const name = "input-keyboard-hotkey-change-cancels-press"
    await prepare(name)
    try {
      const before = requests.length
      await armControl("#p1", `${name}-down`)
      await configure({ translate: { node: { enabled: true, hotkey: "shift" } } })
      await page.keyboard.up("Control")
      await noTranslation("#p1", before, "releasing the previous shortcut must not trigger the newly configured shortcut")
      await page.locator("#p2").hover()
      await page.keyboard.down("Shift")
      await page.waitForTimeout(80)
      await page.keyboard.up("Shift")
      await translatedOnce("#p2", text(name, 2), "the newly configured shortcut works immediately")
      await configure({ translate: { node: { enabled: false, hotkey: "shift" } } })
      const disabledAt = requests.length
      await page.locator("#p3").hover()
      await page.keyboard.down("Shift")
      await page.waitForTimeout(80)
      await page.keyboard.up("Shift")
      await noTranslation("#p3", disabledAt, "disabled node translation ignores its previously valid shortcut")
      await configure({ translate: { node: { enabled: true, hotkey: "control" } } })
      await nodeGesture(page, "#p3")
      await translatedOnce("#p3", text(name, 3), "re-enabling node translation restores its configured shortcut")
      assert.equal(await page.locator(`#p2 ${wrapper}`).count(), 1)
    }
    finally {
      await cleanup(name)
    }
  })

  await check("input-keyboard-focus-editor-cancels-press", async () => {
    const name = "input-keyboard-focus-editor-cancels-press"
    await prepare(name, "control", `${paragraphs(name)}<label>Editable text <input id="editor" value="keep editing" /></label>`)
    try {
      const before = requests.length
      await armControl("#p1", `${name}-down`)
      await page.locator("#editor").focus()
      await page.keyboard.up("Control")
      await noTranslation("#p1", before, "moving keyboard focus to an editor must cancel the previously armed paragraph gesture")
      await page.locator("#p2").click()
      await nodeGesture(page, "#p2")
      await translatedOnce("#p2", text(name, 2), "paragraph gestures recover after leaving an editor")
      assert.equal(await page.locator("#editor").inputValue(), "keep editing", "the editable source value must remain unchanged")
    }
    finally {
      await cleanup(name)
    }
  })

  const editors = [
    { kind: "input", markup: "<input id=\"editor\" value=\"unchanged input\" />" },
    { kind: "textarea", markup: "<textarea id=\"editor\">unchanged textarea</textarea>" },
    { kind: "contenteditable", markup: "<div id=\"editor\" contenteditable=\"true\">unchanged editable text</div>" },
    { kind: "select", markup: "<select id=\"editor\" multiple size=\"2\"><option value=\"one\">First native option</option><option value=\"two\">Second native option</option></select>" },
    { kind: "shadow", markup: "<div id=\"shadow-editor\"></div>" },
  ]
  for (const editor of editors) {
    await check(`input-editor-${editor.kind}`, async () => {
      const name = `input-editor-${editor.kind}`
      await prepare(name, "control", `${paragraphs(name)}<div class="notranslate">${editor.markup}</div>`)
      try {
        if (editor.kind === "shadow") {
          await page.locator("#shadow-editor").evaluate((host) => {
            const root = host.attachShadow({ mode: "open" })
            root.innerHTML = "<label>Shadow editor <input id=\"editor\" value=\"unchanged shadow input\" /></label>"
          })
        }
        await page.locator("#p1").hover()
        await page.locator("#editor").focus()
        const before = requests.length
        await page.keyboard.down("Control")
        await page.waitForTimeout(80)
        await page.keyboard.up("Control")
        await noTranslation("#p1", before, `${editor.kind} keyboard input must not translate the paragraph under a stationary pointer`)
        await page.locator("#p2").click()
        await nodeGesture(page, "#p2")
        await translatedOnce("#p2", text(name, 2), "a fresh gesture outside the editor works on its first attempt")
        assert.equal(await hasTranslation(page, text(name, 1)), false)
      }
      finally {
        await cleanup(name)
      }
    })
  }
}
