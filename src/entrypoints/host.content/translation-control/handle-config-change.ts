import type { PageTranslationManager } from "./page-translation"
import type { Config } from "@/types/config/config"
import { runContentScriptTask } from "@/utils/content-script/lifecycle"

/**
 * Handles config changes and re-translates page when translation mode changes
 * while page translation is active.
 */
export function handleTranslationModeChange(
  newConfig: Config | null,
  oldConfig: Config | null,
  manager: PageTranslationManager,
): void {
  const modeChanged = newConfig && oldConfig && newConfig.translate.mode !== oldConfig.translate.mode

  if (modeChanged && manager.isActive) {
    manager.stop()
    runContentScriptTask(() => manager.start(), "Failed to restart translation after changing mode:")
  }
}
