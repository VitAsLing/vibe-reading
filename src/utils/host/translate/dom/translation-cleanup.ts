import { CONTENT_WRAPPER_CLASS, REACT_SHADOW_HOST_CLASS, TRANSLATION_MODE_ATTRIBUTE } from "../../../constants/dom-labels"
import { removeReactShadowHost } from "../../../react-shadow-host/create-shadow-host"
import { batchDOMOperation } from "../../dom/batch-dom"
import { isHTMLElement, isTranslatedWrapperNode } from "../../dom/filter"
import { deepQueryTopLevelSelector } from "../../dom/find"
import { originalContentMap } from "../core/translation-state"

const translationAbortCleanups = new WeakMap<HTMLElement, () => void>()

export function bindTranslatedWrapperToSignal(wrapper: HTMLElement, signal?: AbortSignal): void {
  if (!signal)
    return

  const onAbort = () => removeTranslatedWrapperWithRestore(wrapper)
  translationAbortCleanups.set(wrapper, () => signal.removeEventListener("abort", onAbort))
  if (signal.aborted)
    onAbort()
  else
    signal.addEventListener("abort", onAbort, { once: true })
}

export function removeShadowHostInTranslatedWrapper(wrapper: HTMLElement): void {
  translationAbortCleanups.get(wrapper)?.()
  translationAbortCleanups.delete(wrapper)
  // Remove React shadow hosts (for error components)
  const translationShadowHost = wrapper.querySelector(`.${REACT_SHADOW_HOST_CLASS}`)
  if (translationShadowHost && isHTMLElement(translationShadowHost)) {
    removeReactShadowHost(translationShadowHost)
  }

  // Remove lightweight spinners
  const spinner = wrapper.querySelector(".vibe-reading-spinner")
  if (spinner) {
    batchDOMOperation(() => spinner.remove())
  }
}

/**
 * Remove translated wrapper and restore original content based on translation mode
 * @param wrapper - The translated wrapper element to remove
 */
export function removeTranslatedWrapperWithRestore(wrapper: HTMLElement): void {
  removeShadowHostInTranslatedWrapper(wrapper)

  const translationMode = wrapper.getAttribute(TRANSLATION_MODE_ATTRIBUTE)

  if (translationMode === "translationOnly") {
    // For translation-only mode, find nearest ancestor in originalContentMap and restore
    let currentNode = wrapper.parentNode

    while (currentNode && isHTMLElement(currentNode)) {
      const originalContent = originalContentMap.get(currentNode)
      if (originalContent) {
        const nodeToRestore = currentNode
        const wrappersToRestore = [...nodeToRestore.querySelectorAll(`.${CONTENT_WRAPPER_CLASS}`)]
        batchDOMOperation(() => {
          // A SPA can replace the source in this same element before the batch
          // runs. Restore only while a wrapper from that source still belongs
          // to it, so delayed cleanup cannot overwrite the new route's DOM.
          if (wrappersToRestore.some(node => nodeToRestore.contains(node))) {
            nodeToRestore.innerHTML = originalContent
          }
        })
        originalContentMap.delete(currentNode)
        return
      }
      currentNode = currentNode.parentNode
    }
  }

  // For bilingual mode or when no original content is found, just remove the wrapper
  batchDOMOperation(() => wrapper.remove())
}

export function removeAllTranslatedWrapperNodes(
  root: Document | ShadowRoot = document,
): void {
  const translatedNodes = deepQueryTopLevelSelector(root, isTranslatedWrapperNode)
  translatedNodes.forEach((contentWrapperNode) => {
    removeTranslatedWrapperWithRestore(contentWrapperNode)
  })
}
