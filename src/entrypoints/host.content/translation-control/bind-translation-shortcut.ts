import type { Hotkey } from "@tanstack/hotkeys"
import type { PageTranslationManager } from "./page-translation"
import type { Config } from "@/types/config/config"
import { HotkeyManager } from "@tanstack/hotkeys"
import { storageAdapter } from "@/utils/atoms/storage-adapter"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { isContentScriptActive, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { isPageTranslationShortcutEmpty, isValidConfiguredPageTranslationShortcut } from "@/utils/page-translation-shortcut"

export async function bindTranslationShortcutKey(pageTranslationManager: PageTranslationManager) {
  if (!isContentScriptActive())
    return () => {}

  let currentShortcut: string | null | undefined
  let unregister: (() => void) | undefined
  let receivedUpdate = false
  const bind = (shortcut: string | null | undefined) => {
    if (!isContentScriptActive() || shortcut === currentShortcut)
      return
    unregister?.()
    unregister = undefined
    currentShortcut = shortcut
    if (!shortcut || isPageTranslationShortcutEmpty(shortcut) || !isValidConfiguredPageTranslationShortcut(shortcut))
      return

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
      { ignoreInputs: true, preventDefault: true, stopPropagation: true },
    )
    unregister = () => registration.unregister()
  }

  // Subscribe before reading so an old initial response cannot replace a
  // shortcut changed while this open page is still bootstrapping.
  const unwatch = storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, (config) => {
    receivedUpdate = true
    bind(config?.translate?.page?.shortcut)
  })
  const cleanup = () => {
    unwatch()
    unregister?.()
  }
  try {
    const config = await getLocalConfig()
    if (!receivedUpdate)
      bind(config?.translate.page.shortcut)
    return cleanup
  }
  catch (error) {
    cleanup()
    throw error
  }
}
