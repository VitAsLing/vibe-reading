import type { ContentScriptContext } from "#imports"

let contentScriptContext: ContentScriptContext | undefined
const validityIntervalMs = 1000
const messageConnectionError = /message (?:port|channel) closed|receiving end does not exist|^No response$/i

export function initializeContentScriptLifecycle(ctx: ContentScriptContext): void {
  contentScriptContext = ctx
  // Chrome leaves old content scripts in open pages after an extension reload.
  // WXT checks runtime.id before every managed tick; the callback has no work.
  ctx.setInterval(() => {}, validityIntervalMs)
}

export function isContentScriptActive(): boolean {
  // Shared helpers also run in extension pages/background, where no host
  // content-script lifecycle is registered.
  return contentScriptContext?.isValid ?? true
}

export function assertContentScriptActive(): void {
  if (!isContentScriptActive()) {
    throw new Error("Content script context invalidated")
  }
}

export function isContentScriptInvalidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Chrome and assertContentScriptActive throw a plain Error with this exact
  // message. Remote provider errors preserve their own name over messaging;
  // their text must not invalidate a healthy document or remove its Retry UI.
  if (error instanceof Error && error.name === "Error"
    && /^(?:extension|content script) context invalidated\.?$/i.test(message)) {
    contentScriptContext?.notifyInvalidated()
    return true
  }

  return !isContentScriptActive()
    && messageConnectionError.test(message)
}

export async function reportContentScriptError(message: string, error: unknown): Promise<void> {
  if (isContentScriptInvalidationError(error))
    return

  const errorMessage = error instanceof Error ? error.message : String(error)
  if (contentScriptContext && messageConnectionError.test(errorMessage)) {
    const ctx = contentScriptContext
    // Chrome can close pending replies before invalidating runtime.id. A frozen
    // tab also receives these replies before its managed validity tick resumes.
    // Allow a full validity interval before rechecking. The next task alone
    // can still precede Chrome's binding invalidation in a foreground tab.
    // Invalidation cancels the report; a live context keeps the original error.
    await new Promise<void>((resolve) => {
      let removeInvalidationListener = () => {}
      const timeout = setTimeout(() => {
        removeInvalidationListener()
        if (ctx.isValid && !isContentScriptInvalidationError(error))
          console.error(message, error)
        resolve()
      }, validityIntervalMs)
      removeInvalidationListener = ctx.onInvalidated(() => {
        clearTimeout(timeout)
        removeInvalidationListener()
        resolve()
      })
    })
    return
  }

  console.error(message, error)
}

export function runContentScriptTask(task: () => Promise<unknown>, message: string): void {
  if (!isContentScriptActive())
    return

  void (async () => {
    try {
      await task()
    }
    catch (error) {
      await reportContentScriptError(message, error)
    }
  })()
}
