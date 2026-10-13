import "@/utils/zod-config"
import { defineContentScript } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { initializeContentScriptLifecycle, isContentScriptActive, isContentScriptInvalidationError } from "@/utils/content-script/lifecycle"
import { loadUiLocaleMessages } from "@/utils/i18n"

declare global {
  interface Window {
    __READ_FROG_HOST_INJECTED__?: boolean
  }
}

export default defineContentScript({
  matches: ["*://*/*", "file:///*"],
  cssInjectionMode: "manual",
  async main(ctx) {
    // Prevent double injection (manifest-based + programmatic injection)
    if (window.__READ_FROG_HOST_INJECTED__)
      return
    window.__READ_FROG_HOST_INJECTED__ = true
    ctx.onInvalidated(() => {
      window.__READ_FROG_HOST_INJECTED__ = false
    })
    initializeContentScriptLifecycle(ctx)

    try {
      if (!isContentScriptActive())
        return
      const initialConfig = await getLocalConfig()
      if (!isContentScriptActive())
        return
      await loadUiLocaleMessages(initialConfig?.uiLocale ?? DEFAULT_CONFIG.uiLocale, { applyDocumentLang: false })
      if (!isContentScriptActive())
        return

      const { bootstrapHostContent } = await import("./runtime")
      if (isContentScriptActive()) {
        await bootstrapHostContent(ctx, initialConfig)
      }
    }
    catch (error) {
      const invalidated = !ctx.isValid || isContentScriptInvalidationError(error)
      ctx.notifyInvalidated()
      if (!invalidated) {
        throw error
      }
    }
  },
})
