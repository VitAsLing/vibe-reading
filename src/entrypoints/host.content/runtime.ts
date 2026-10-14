import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import { storageAdapter } from "@/utils/atoms/storage-adapter"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { isContentScriptActive, reportContentScriptError, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { detectPageLanguageLightweight } from "@/utils/content/page-language"
import { cancelDocumentTranslations, initializeTranslationOperations } from "@/utils/host/translate/core/translation-operations"
import { setContentTranslationNodeStyle } from "@/utils/host/translate/ui/decorate-translation"
import { ensurePresetStyles } from "@/utils/host/translate/ui/style-injector"
import { logger } from "@/utils/logger"
import { onMessage, sendMessage } from "@/utils/message"
import { areSamePageTranslationOrigin } from "@/utils/url"
import { setupUrlChangeListener } from "./listen"
import { mountHostToast } from "./mount-host-toast"
import { bindTranslationShortcutKey } from "./translation-control/bind-translation-shortcut"
import { handleTranslationModeChange } from "./translation-control/handle-config-change"
import { registerNodeTranslationTriggers } from "./translation-control/node-translation"
import { PageTranslationManager } from "./translation-control/page-translation"

export async function bootstrapHostContent(ctx: ContentScriptContext, initialConfig: Config | null) {
  const cleanups: Array<() => void> = []
  let disposed = false
  const addCleanup = (cleanup: () => void) => {
    if (disposed)
      cleanup()
    else
      cleanups.push(cleanup)
  }
  const dispose = () => {
    if (disposed)
      return
    disposed = true
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup()
      }
      catch (error) {
        reportContentScriptError("Failed to clean up host content:", error)
      }
    }
  }
  addCleanup(ctx.onInvalidated(dispose))

  try {
    if (!isContentScriptActive())
      return
    addCleanup(initializeTranslationOperations())
    ensurePresetStyles(document)
    addCleanup(setupUrlChangeListener())
    if (window === window.top)
      addCleanup(mountHostToast())
    addCleanup(registerNodeTranslationTriggers())

    const preloadConfig = initialConfig?.translate.page.preload ?? DEFAULT_CONFIG.translate.page.preload
    const manager = new PageTranslationManager({
      root: null,
      rootMargin: `${preloadConfig.margin}px`,
      threshold: preloadConfig.threshold,
    })
    addCleanup(() => manager.dispose())
    addCleanup(manager.registerPageTranslationTriggers())
    let previousConfig = initialConfig
    let configVersion = 0
    setContentTranslationNodeStyle(null)
    addCleanup(() => setContentTranslationNodeStyle(null))
    addCleanup(storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, (config) => {
      configVersion++
      const previous = previousConfig
      previousConfig = config
      setContentTranslationNodeStyle(config.translate.translationNodeStyle)
      handleTranslationModeChange(config, previous, manager)
    }))
    // A setting saved before this listener was registered may be newer than
    // bootstrap's config. An observed update owns any late initial read.
    const readVersion = configVersion
    const currentConfig = await getLocalConfig()
    if (!isContentScriptActive())
      return
    if (readVersion === configVersion && currentConfig) {
      previousConfig = currentConfig
      setContentTranslationNodeStyle(currentConfig.translate.translationNodeStyle)
    }
    addCleanup(await bindTranslationShortcutKey(manager))
    if (!isContentScriptActive())
      return

    let languageDetectionVersion = 0
    const detectAndReportPageLanguage = async (url: string) => {
      if (!isContentScriptActive())
        return

      // Let navigation handlers finish updating the title and body before sampling.
      await Promise.resolve()
      if (!isContentScriptActive() || window.location.href !== url)
        return

      const version = ++languageDetectionVersion
      const { detectedCodeOrUnd } = await detectPageLanguageLightweight()
      if (isContentScriptActive() && version === languageDetectionVersion && window.location.href === url) {
        await sendMessage("reportDetectedPageLanguage", { url, detectedCodeOrUnd })
      }
    }

    // For late-loading iframes: check if translation is already enabled for this tab.
    const initialSessionVersion = manager.currentSessionVersion
    let translationEnabled = false
    try {
      translationEnabled = await sendMessage("getEnablePageTranslationFromContentScript", undefined)
    }
    catch (error) {
      reportContentScriptError("Failed to check translation state:", error)
    }
    if (!isContentScriptActive())
      return
    if (translationEnabled && manager.currentSessionVersion === initialSessionVersion) {
      runContentScriptTask(() => manager.start(), "Failed to start page translation:")
    }

    const handleUrlChange = async (from: string, to: string) => {
      if (from !== to) {
        logger.info("URL changed from", from, "to", to)
        if (manager.isActive) {
          if (areSamePageTranslationOrigin(from, to)) {
            await manager.restart()
          }
          else {
            manager.stop()
          }
        }
        else {
          cancelDocumentTranslations()
        }
        if (window === window.top) {
          await detectAndReportPageLanguage(to)
        }
      }
    }

    const handleExtensionUrlChange = (e: any) => {
      const { from, to } = e.detail
      runContentScriptTask(() => handleUrlChange(from, to), "Failed to handle page navigation:")
    }
    window.addEventListener("extension:URLChange", handleExtensionUrlChange)
    addCleanup(() => window.removeEventListener("extension:URLChange", handleExtensionUrlChange))

    const toggleTranslation = async (enabled: boolean) => {
      if (!isContentScriptActive())
        return false
      if (enabled)
        await manager.start()
      else if (manager.isActive)
        manager.stop()
      return isContentScriptActive() && manager.isEnabled
    }
    addCleanup(onMessage("askManagerToTogglePageTranslation", msg => toggleTranslation(msg.data.enabled)))
    if (window !== window.top) {
      addCleanup(onMessage("notifyTranslationStateChanged", async (msg) => {
        await toggleTranslation(msg.data.enabled)
      }))
    }
    else {
      addCleanup(onMessage("refreshDetectedPageLanguage", () => {
        runContentScriptTask(() => detectAndReportPageLanguage(window.location.href), "Failed to refresh page language:")
      }))
      await detectAndReportPageLanguage(window.location.href)
    }
  }
  catch (error) {
    dispose()
    throw error
  }
}
