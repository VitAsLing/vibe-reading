import type { Hotkey } from "@tanstack/hotkeys"
import type { PageTranslationManager } from "./page-translation"
import { HotkeyManager } from "@tanstack/hotkeys"
import { getLocalConfig } from "@/utils/config/storage"
import { isContentScriptActive, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { isPageTranslationShortcutEmpty, isValidConfiguredPageTranslationShortcut } from "@/utils/page-translation-shortcut"

/**
 * Binds page translation shortcut key from the given config.
 * Uses sync cached config inside the hotkey callback to avoid async overhead.
 */
export async function bindTranslationShortcutKey(pageTranslationManager: PageTranslationManager) {
  if (!isContentScriptActive())
    return () => {}
  const config = await getLocalConfig()
  if (!isContentScriptActive() || !config || isPageTranslationShortcutEmpty(config.translate.page.shortcut)) {
    return () => {}
  }

  const shortcut = config.translate.page.shortcut
  if (!isValidConfiguredPageTranslationShortcut(shortcut)) {
    return () => {}
  }

  const registration = HotkeyManager.getInstance().register(
    shortcut as Hotkey,
    () => {
      if (!isContentScriptActive())
        return
      if (pageTranslationManager.isActive) {
        pageTranslationManager.stop()
      }
      else {
        runContentScriptTask(() => pageTranslationManager.start(), "Failed to start page translation:")
      }
    },
    {
      ignoreInputs: true,
      preventDefault: true,
      stopPropagation: true,
    },
  )

  return () => {
    registration.unregister()
  }
}
