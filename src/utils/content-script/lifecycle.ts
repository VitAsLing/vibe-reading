import type { ContentScriptContext } from "#imports"

let contentScriptContext: ContentScriptContext | undefined
const messageConnectionError = /message (?:port|channel) closed|receiving end does not exist|^No response$/i

export function initializeContentScriptLifecycle(ctx: ContentScriptContext): void {
  contentScriptContext = ctx
  // Chrome leaves old content scripts in open pages after an extension reload.
  // WXT checks runtime.id before every managed tick; the callback has no work.
  ctx.setInterval(() => {}, 1000)
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
  if (/\b(?:extension|content script) context invalidated\b/i.test(message)) {
    contentScriptContext?.notifyInvalidated()
    return true
  }

  return !isContentScriptActive()
    && messageConnectionError.test(message)
}

export function reportContentScriptError(message: string, error: unknown): void {
  if (isContentScriptInvalidationError(error))
    return

  const errorMessage = error instanceof Error ? error.message : String(error)
  if (contentScriptContext && messageConnectionError.test(errorMessage)) {
    const ctx = contentScriptContext
    // Chrome can close pending replies before invalidating runtime.id. A frozen
    // tab also receives these replies before its managed validity tick resumes.
    // Recheck in the next managed task: reloading cancels it, while a live
    // extension still reports the original failure. No request is retried.
    let removeInvalidationListener = () => {}
    const timeout = setTimeout(() => {
      removeInvalidationListener()
      if (ctx.isValid && !isContentScriptInvalidationError(error))
        console.error(message, error)
    }, 0)
    removeInvalidationListener = ctx.onInvalidated(() => {
      clearTimeout(timeout)
      removeInvalidationListener()
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
      reportContentScriptError(message, error)
    }
  })()
}
