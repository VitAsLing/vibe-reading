import type { Config } from "@/types/config/config"
import type { Point } from "@/types/dom"
import { HOTKEY_EVENT_KEYS } from "@/utils/constants/hotkeys"
import { isContentScriptActive, reportContentScriptError, runContentScriptTask } from "@/utils/content-script/lifecycle"

const NODE_TRANSLATION_HOLD_TRIGGER_MS = 500
const CLICK_AND_HOLD_MOVE_TOLERANCE = 6
const MOUSEMOVE_THROTTLE_MS = 300
const MOUSEMOVE_DISTANCE_THRESHOLD = 3
const KEYBOARD_HOTKEYS = new Set(Object.entries(HOTKEY_EVENT_KEYS).filter(([hotkey]) => hotkey !== "clickAndHold").map(([, key]) => key))

export interface NodeTranslationTriggerOptions {
  getConfig: () => Promise<Config | null>
  getOperationSignal?: () => AbortSignal
  onTrigger: (point: Point, config: Config, signal?: AbortSignal) => void | Promise<void>
  shouldIgnoreEvent?: () => boolean
}

interface PressState {
  cancelled: boolean
  claimed: boolean
  startedAt: number
  operationSignal?: AbortSignal
  timerId: ReturnType<typeof setTimeout> | null
  removeAbortListener?: () => void
}

interface MousePress extends PressState {
  kind: "mouse"
  point: Point
}

interface KeyboardPress extends PressState {
  kind: "keyboard"
  physicalKey: string
  key: string
  released: boolean
  releasePoint: Point | null
  initialConfig: Promise<Config | null> | null
}

type Press = MousePress | KeyboardPress

function isEditableElement(target: unknown): boolean {
  return target instanceof HTMLElement
    && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
}

function hasEditableFocus(): boolean {
  let focused = document.activeElement
  while (focused) {
    if (isEditableElement(focused))
      return true
    focused = focused.shadowRoot?.activeElement ?? null
  }
  return false
}

function isEditableEvent(event: Event): boolean {
  return event.composedPath().some(isEditableElement) || isEditableElement(event.target)
}

function isDocumentSurfaceTarget(target: EventTarget | null): boolean {
  return target === document
    || target === window
    || target === document.documentElement
    || target === document.body
}

/** Register paragraph gestures while keeping each physical press independent. */
export function registerNodeTranslationTriggerListeners({
  getConfig,
  getOperationSignal,
  onTrigger,
  shouldIgnoreEvent = () => false,
}: NodeTranslationTriggerOptions): () => void {
  const ac = new AbortController()
  const { signal } = ac
  const mousePosition: Point = { x: 0, y: 0 }
  let hasMousePosition = false
  let lastMoveX = 0
  let lastMoveY = 0
  let moveThrottleTimer: ReturnType<typeof setTimeout> | null = null
  let mousePress: MousePress | null = null
  const pressedKeys = new Set<string>()
  const keyboardPresses = new Map<string, KeyboardPress>()
  // Released pure shortcuts can still be awaiting configuration. A later
  // press must not overwrite their coordinates or claim/reset their action.
  const pendingKeyboardPresses = new Set<KeyboardPress>()

  const updateMousePosition = (point: Point) => {
    mousePosition.x = point.x
    mousePosition.y = point.y
    hasMousePosition = true
  }

  const resolveTriggerPoint = (): Point => {
    if (hasMousePosition)
      return { ...mousePosition }
    const hoveredElements = document.querySelectorAll(":hover")
    const hovered = hoveredElements.item(hoveredElements.length - 1)
    if (hovered) {
      const rect = hovered.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return { ...mousePosition }
  }

  const clearPressTimer = (press: Press) => {
    if (press.timerId !== null) {
      clearTimeout(press.timerId)
      press.timerId = null
    }
  }

  const discard = (press: Press) => {
    press.cancelled = true
    clearPressTimer(press)
    press.removeAbortListener?.()
    press.removeAbortListener = undefined
    if (press.kind === "mouse") {
      if (mousePress === press)
        mousePress = null
    }
    else {
      pendingKeyboardPresses.delete(press)
      if (keyboardPresses.get(press.physicalKey) === press)
        keyboardPresses.delete(press.physicalKey)
    }
  }

  const cancelCandidates = () => {
    if (mousePress)
      discard(mousePress)
    for (const press of [...pendingKeyboardPresses, ...keyboardPresses.values()])
      discard(press)
    pressedKeys.clear()
  }

  const bindOperation = (press: Press) => {
    if (!press.operationSignal)
      return
    const onAbort = () => discard(press)
    press.operationSignal.addEventListener("abort", onAbort, { once: true })
    press.removeAbortListener = () => press.operationSignal?.removeEventListener("abort", onAbort)
  }

  const canClaim = (press: Press) => !press.cancelled && !press.claimed
    && !signal.aborted && isContentScriptActive() && !shouldIgnoreEvent()
    && !press.operationSignal?.aborted

  const readConfig = async (press: Press): Promise<Config | null> => {
    if (!canClaim(press))
      return null
    try {
      const config = await getConfig()
      return canClaim(press) ? config : null
    }
    catch (error) {
      discard(press)
      void reportContentScriptError("Failed to read paragraph gesture configuration:", error)
      return null
    }
  }

  const matchesKeyboardConfig = (press: KeyboardPress, config: Config | null): config is Config => !!config
    && config.translate.node.enabled && config.translate.node.hotkey !== "clickAndHold"
    && HOTKEY_EVENT_KEYS[config.translate.node.hotkey] === press.key

  const claim = (press: Press, point: Point, config: Config) => {
    if (!canClaim(press))
      return
    press.claimed = true
    clearPressTimer(press)
    press.removeAbortListener?.()
    press.removeAbortListener = undefined
    if (press.kind === "keyboard")
      pendingKeyboardPresses.delete(press)
    runContentScriptTask(async () => {
      if (signal.aborted || press.operationSignal?.aborted || shouldIgnoreEvent())
        return
      if (press.operationSignal)
        await onTrigger(point, config, press.operationSignal)
      else
        await onTrigger(point, config)
    }, "Failed to trigger paragraph translation:")
  }

  const cancelMovedMousePress = (event: MouseEvent | PointerEvent) => {
    if (mousePress && Math.hypot(event.clientX - mousePress.point.x, event.clientY - mousePress.point.y) > CLICK_AND_HOLD_MOVE_TOLERANCE)
      discard(mousePress)
  }

  document.addEventListener("mousemove", (event) => {
    if (shouldIgnoreEvent())
      return
    // Cancellation precedes both jitter filtering and hover throttling. A
    // pointerover event can already have updated the last hover coordinates.
    cancelMovedMousePress(event)
    if (Math.abs(event.clientX - lastMoveX) + Math.abs(event.clientY - lastMoveY) <= MOUSEMOVE_DISTANCE_THRESHOLD)
      return
    if (moveThrottleTimer)
      return
    moveThrottleTimer = setTimeout(() => {
      moveThrottleTimer = null
    }, MOUSEMOVE_THROTTLE_MS)
    updateMousePosition({ x: event.clientX, y: event.clientY })
    lastMoveX = event.clientX
    lastMoveY = event.clientY
  }, { signal })

  const updateMousePositionFromEvent = (event: MouseEvent | PointerEvent) => {
    if (shouldIgnoreEvent())
      return
    cancelMovedMousePress(event)
    updateMousePosition({ x: event.clientX, y: event.clientY })
    lastMoveX = event.clientX
    lastMoveY = event.clientY
  }
  document.addEventListener("mouseover", updateMousePositionFromEvent, { signal })
  document.addEventListener("pointerover", updateMousePositionFromEvent, { signal })

  document.addEventListener("mousedown", (event) => {
    if (shouldIgnoreEvent() || event.button !== 0)
      return
    if (mousePress)
      discard(mousePress)
    if (isEditableEvent(event) || isDocumentSurfaceTarget(event.target))
      return
    const operationSignal = getOperationSignal?.()
    if (operationSignal?.aborted)
      return
    const press: MousePress = {
      kind: "mouse", point: { x: event.clientX, y: event.clientY }, startedAt: performance.now(),
      operationSignal, cancelled: false, claimed: false, timerId: null,
    }
    mousePress = press
    bindOperation(press)
    runContentScriptTask(async () => {
      const config = await readConfig(press)
      if (!config?.translate.node.enabled || config.translate.node.hotkey !== "clickAndHold" || mousePress !== press) {
        discard(press)
        return
      }
      press.timerId = setTimeout(() => {
        runContentScriptTask(async () => {
          if (!canClaim(press) || mousePress !== press)
            return
          const currentConfig = await readConfig(press)
          if (!canClaim(press) || mousePress !== press)
            return
          if (!currentConfig?.translate.node.enabled || currentConfig.translate.node.hotkey !== "clickAndHold" || hasEditableFocus()) {
            discard(press)
            return
          }
          claim(press, press.point, currentConfig)
        }, "Failed to handle paragraph hold gesture:")
      }, Math.max(0, NODE_TRANSLATION_HOLD_TRIGGER_MS - (performance.now() - press.startedAt)))
    }, "Failed to handle paragraph mouse interaction:")
  }, { signal })

  document.addEventListener("mouseup", (event) => {
    if (event.button === 0 && mousePress)
      discard(mousePress)
  }, { signal })

  document.addEventListener("keydown", (event) => {
    const physicalKey = event.code || event.key
    const alreadyPressed = pressedKeys.has(physicalKey)
    const hasOtherPressedKey = [...pressedKeys].some(key => key !== physicalKey)
    const hasOtherModifier = (event.ctrlKey && event.key !== "Control")
      || (event.altKey && event.key !== "Alt")
      || (event.metaKey && event.key !== "Meta")
      || (event.shiftKey && event.key !== "Shift")
    // Physical state and combination cancellation never await storage.
    for (const press of keyboardPresses.values()) {
      if (press.physicalKey !== physicalKey)
        discard(press)
    }
    pressedKeys.add(physicalKey)
    if (shouldIgnoreEvent() || signal.aborted || event.repeat || alreadyPressed || !KEYBOARD_HOTKEYS.has(event.key))
      return
    if (isEditableEvent(event) || hasEditableFocus()) {
      cancelCandidates()
      return
    }
    if (hasOtherPressedKey || hasOtherModifier)
      return
    const operationSignal = getOperationSignal?.()
    if (operationSignal?.aborted)
      return
    const press: KeyboardPress = {
      kind: "keyboard", physicalKey, key: event.key, released: false, releasePoint: null,
      startedAt: performance.now(), operationSignal, cancelled: false, claimed: false, timerId: null, initialConfig: null,
    }
    keyboardPresses.set(physicalKey, press)
    pendingKeyboardPresses.add(press)
    bindOperation(press)
    press.initialConfig = readConfig(press)
    runContentScriptTask(async () => {
      const config = await press.initialConfig
      if (!matchesKeyboardConfig(press, config)) {
        discard(press)
        return
      }
      if (!canClaim(press) || press.released)
        return
      press.timerId = setTimeout(() => {
        runContentScriptTask(async () => {
          if (!canClaim(press) || press.released || hasEditableFocus())
            return
          const point = resolveTriggerPoint()
          const currentConfig = await readConfig(press)
          if (!canClaim(press) || press.released || hasEditableFocus())
            return
          if (!matchesKeyboardConfig(press, currentConfig)) {
            discard(press)
            return
          }
          claim(press, point, currentConfig)
        }, "Failed to handle paragraph hold shortcut:")
      }, Math.max(0, NODE_TRANSLATION_HOLD_TRIGGER_MS - (performance.now() - press.startedAt)))
    }, "Failed to handle paragraph shortcut keydown:")
  }, { signal })

  document.addEventListener("keyup", (event) => {
    const physicalKey = event.code || event.key
    pressedKeys.delete(physicalKey)
    const press = keyboardPresses.get(physicalKey)
    if (!press)
      return
    keyboardPresses.delete(physicalKey)
    press.released = true
    press.releasePoint = resolveTriggerPoint()
    clearPressTimer(press)
    if (!canClaim(press) || isEditableEvent(event) || hasEditableFocus()) {
      discard(press)
      return
    }
    runContentScriptTask(async () => {
      const currentConfig = await readConfig(press)
      const initialConfig = await press.initialConfig
      if (!matchesKeyboardConfig(press, initialConfig) || !matchesKeyboardConfig(press, currentConfig) || hasEditableFocus()) {
        discard(press)
        return
      }
      if (press.releasePoint)
        claim(press, press.releasePoint, currentConfig)
    }, "Failed to handle paragraph shortcut keyup:")
  }, { signal })

  document.addEventListener("focusin", (event) => {
    if (isEditableEvent(event) || hasEditableFocus())
      cancelCandidates()
  }, { signal })
  window.addEventListener("blur", cancelCandidates, { signal })

  return () => {
    ac.abort()
    cancelCandidates()
    if (moveThrottleTimer) {
      clearTimeout(moveThrottleTimer)
      moveThrottleTimer = null
    }
  }
}
