import type { Config } from "@/types/config/config"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { isContentScriptActive, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { getDocumentTranslationSignal } from "@/utils/host/translate/core/translation-operations"
import { removeOrShowNodeTranslation } from "@/utils/host/translate/node-manipulation"
import { sendMessage } from "@/utils/message"
import { registerNodeTranslationTriggerListeners } from "./node-translation-trigger"

/**
 * Registers node translation triggers based on the current config.
 * Returns a teardown function to remove all listeners.
 *
 * Config is read on demand when the interaction fires so long-lived content
 * scripts don't drift if the page was frozen and missed storage events.
 */
export function registerNodeTranslationTriggers(): () => void {
  const ac = new AbortController()
  const { signal } = ac

  const getCurrentConfig = async (): Promise<Config | null> => {
    if (!isContentScriptActive() || signal.aborted)
      return null
    const config = await getLocalConfig()
    if (!isContentScriptActive() || signal.aborted)
      return null
    return config ?? DEFAULT_CONFIG
  }

  let hasRequestedIframeInjection = false

  const requestIframeInjectionAfterSuccessfulTopFrameNodeTranslation = () => {
    if (!isContentScriptActive() || hasRequestedIframeInjection || window !== window.top || signal.aborted)
      return

    hasRequestedIframeInjection = true
    runContentScriptTask(
      () => sendMessage("injectCurrentIframesAfterTopFrameNodeTranslation", undefined),
      "Failed to initialize iframe paragraph translation:",
    )
  }

  const translateNode = async (point: Parameters<typeof removeOrShowNodeTranslation>[0], config: Config, operationSignal = getDocumentTranslationSignal()) => {
    const didTranslate = await removeOrShowNodeTranslation(point, config, operationSignal)
    if (didTranslate && !operationSignal.aborted) {
      requestIframeInjectionAfterSuccessfulTopFrameNodeTranslation()
    }
  }

  const teardownTriggerListeners = registerNodeTranslationTriggerListeners({
    getConfig: getCurrentConfig,
    getOperationSignal: getDocumentTranslationSignal,
    shouldIgnoreEvent: () => !isContentScriptActive() || signal.aborted,
    onTrigger: translateNode,
  })

  // Teardown: abort all listeners + cancel pending timers
  return () => {
    ac.abort()
    teardownTriggerListeners()
  }
}
