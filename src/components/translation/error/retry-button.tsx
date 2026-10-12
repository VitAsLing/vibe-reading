import { IconReload } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { use } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import { runContentScriptTask } from "@/utils/content-script/lifecycle"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { removeShadowHostInTranslatedWrapper } from "@/utils/host/translate/dom/translation-cleanup"
import { translateNodesBilingualMode, translateNodeTranslationOnlyMode } from "@/utils/host/translate/node-manipulation"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"

export function RetryButton({ nodes, signal }: { nodes: ChildNode[], signal?: AbortSignal }) {
  const shadowWrapper = use(ShadowWrapperContext)
  const config = useAtomValue(configAtom)
  const translationMode = config.translate.mode

  const handleRetry = () => {
    runContentScriptTask(async () => {
      if (signal?.aborted)
        return
      const shadowRoot = shadowWrapper?.getRootNode()
      const failedWrapper = shadowRoot instanceof ShadowRoot
        ? shadowRoot.host.closest<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)
        : null
      if (failedWrapper) {
        // A failed translation has kept its source nodes. Removing only its
        // error wrapper preserves those live references and sibling groups.
        removeShadowHostInTranslatedWrapper(failedWrapper)
        failedWrapper.remove()
      }
      const walkId = getRandomUUID()
      if (translationMode === "bilingual") {
        await translateNodesBilingualMode(nodes, walkId, config, false, false, signal)
      }
      else if (translationMode === "translationOnly") {
        await translateNodeTranslationOnlyMode(nodes, walkId, config, false, signal)
      }
    }, "Failed to retry paragraph translation:")
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            onClick={handleRetry}
          />
        )}
      >
        <IconReload className="size-4 text-blue-500 hover:text-blue-600 dark:hover:text-blue-400" />
      </TooltipTrigger>
      <TooltipContent container={shadowWrapper} side="bottom" className="notranslate">
        Retry translation
      </TooltipContent>
    </Tooltip>
  )
}
