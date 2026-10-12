import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import type { TransNode } from "@/types/dom"
import { isContentScriptActive } from "@/utils/content-script/lifecycle"
import {
  CONTENT_WRAPPER_CLASS,
  NOTRANSLATE_CLASS,
  TRANSLATION_MODE_ATTRIBUTE,
  WALKED_ATTRIBUTE,
} from "../../../constants/dom-labels"
import { batchDOMOperation } from "../../dom/batch-dom"
import { isBlockTransNode, isHTMLElement, isTextNode, isTransNode } from "../../dom/filter"
import { unwrapDeepestOnlyHTMLChild } from "../../dom/find"
import { getOwnerDocument } from "../../dom/node"
import { extractTextContent } from "../../dom/traversal"
import { bindTranslatedWrapperToSignal, removeShadowHostInTranslatedWrapper, removeTranslatedWrapperWithRestore } from "../dom/translation-cleanup"
import { insertTranslatedNodeIntoWrapper } from "../dom/translation-insertion"
import { findPreviousTranslatedWrapperInside } from "../dom/translation-wrapper"
import { shouldFilterSmallParagraph } from "../filter-small-paragraph"
import { prepareTranslationText } from "../text-preparation"
import { setTranslationDirAndLang } from "../translation-attributes"
import { createSpinnerInside, getTranslatedTextAndRemoveSpinner } from "../ui/spinner"
import { isNumericContent } from "../ui/translation-utils"
import { MARK_ATTRIBUTES_REGEX, originalContentMap, translatingNodes } from "./translation-state"

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

function acquireTranslationNodes(nodes: ChildNode[], signal?: AbortSignal): (() => void) | null {
  if (signal?.aborted || nodes.every(node => translatingNodes.has(node)))
    return null

  const operation = Symbol("translation operation")
  nodes.forEach(node => translatingNodes.set(node, operation))
  const release = () => {
    signal?.removeEventListener("abort", release)
    // Cancellation can let a new session reuse these nodes while the old HTTP
    // request is pending. Its eventual finally must not release the new lock.
    for (const node of nodes) {
      if (translatingNodes.get(node) === operation) {
        translatingNodes.delete(node)
      }
    }
  }
  signal?.addEventListener("abort", release, { once: true })
  return release
}

function getDisplayTranslation(sourceText: string, translatedText: string | undefined) {
  if (translatedText === undefined) {
    return undefined
  }

  return prepareTranslationText(sourceText) === prepareTranslationText(translatedText)
    ? ""
    : translatedText
}

export async function translateNodes(
  nodes: ChildNode[],
  walkId: string,
  toggle: boolean = false,
  config: Config,
  forceBlockTranslation: boolean = false,
  signal?: AbortSignal,
): Promise<void> {
  const translationMode = config.translate.mode
  if (translationMode === "translationOnly") {
    await translateNodeTranslationOnlyMode(nodes, walkId, config, toggle, signal)
  }
  else if (translationMode === "bilingual") {
    await translateNodesBilingualMode(nodes, walkId, config, toggle, forceBlockTranslation, signal)
  }
}

export async function translateNodesBilingualMode(
  nodes: ChildNode[],
  walkId: string,
  config: Config,
  toggle: boolean = false,
  forceBlockTranslation: boolean = false,
  signal?: AbortSignal,
): Promise<void> {
  if (!isContentScriptActive() || signal?.aborted)
    return
  const transNodes = nodes.filter(node => isTransNode(node))
  if (transNodes.length === 0) {
    return
  }
  const releaseNodes = acquireTranslationNodes(transNodes, signal)
  if (!releaseNodes)
    return
  try {
    const lastNode = transNodes.at(-1)!
    const targetNode
      = transNodes.length === 1 && isBlockTransNode(lastNode) && isHTMLElement(lastNode)
        ? await unwrapDeepestOnlyHTMLChild(lastNode)
        : lastNode
    if (signal?.aborted)
      return

    const existedTranslatedWrapper = findPreviousTranslatedWrapperInside(targetNode, walkId)
    if (existedTranslatedWrapper) {
      removeTranslatedWrapperWithRestore(existedTranslatedWrapper)
      if (toggle) {
        return
      }
      else {
        releaseNodes()
        await translateNodesBilingualMode(nodes, walkId, config, toggle, forceBlockTranslation, signal)
        return
      }
    }

    const textContent = transNodes.map(node => extractTextContent(node, config)).join("").trim()
    if (!textContent || isNumericContent(textContent))
      return

    if (await shouldFilterSmallParagraph(textContent, config))
      return
    if (!isContentScriptActive() || signal?.aborted)
      return

    const ownerDoc = getOwnerDocument(targetNode)
    const translatedWrapperNode = ownerDoc.createElement("span")
    translatedWrapperNode.className = `${NOTRANSLATE_CLASS} ${CONTENT_WRAPPER_CLASS}`
    translatedWrapperNode.setAttribute(TRANSLATION_MODE_ATTRIBUTE, "bilingual" satisfies TranslationMode)
    translatedWrapperNode.setAttribute(WALKED_ATTRIBUTE, walkId)
    setTranslationDirAndLang(translatedWrapperNode, config)
    const spinner = createSpinnerInside(translatedWrapperNode)
    bindTranslatedWrapperToSignal(translatedWrapperNode, signal)

    // Batch DOM insertion to reduce layout thrashing
    const insertOperation = () => {
      if (!isContentScriptActive() || signal?.aborted)
        return
      if (isTextNode(targetNode) || transNodes.length > 1) {
        targetNode.parentNode?.insertBefore(
          translatedWrapperNode,
          targetNode.nextSibling,
        )
      }
      else {
        targetNode.appendChild(translatedWrapperNode)
      }
    }
    batchDOMOperation(insertOperation)

    const realTranslatedText = await getTranslatedTextAndRemoveSpinner(nodes, textContent, spinner, translatedWrapperNode, signal)
    if (!isContentScriptActive() || signal?.aborted)
      return

    const translatedText = getDisplayTranslation(textContent, realTranslatedText)

    if (!translatedText) {
      // Only remove wrapper if translation returned empty (not needed),
      // but keep it for error display (undefined)
      if (translatedText === "") {
        // Batch the remove operation to execute remove operation after insert operation
        batchDOMOperation(() => {
          removeShadowHostInTranslatedWrapper(translatedWrapperNode)
          translatedWrapperNode.remove()
        })
      }
      return
    }

    await insertTranslatedNodeIntoWrapper(
      translatedWrapperNode,
      targetNode,
      translatedText,
      config.translate.translationNodeStyle,
      forceBlockTranslation,
    )
  }
  finally {
    releaseNodes()
  }
}

export async function translateNodeTranslationOnlyMode(
  nodes: ChildNode[],
  walkId: string,
  config: Config,
  toggle: boolean = false,
  signal?: AbortSignal,
): Promise<void> {
  if (!isContentScriptActive() || signal?.aborted)
    return
  const isTransNodeAndNotTranslatedWrapper = (node: Node): node is TransNode => {
    if (isHTMLElement(node) && node.classList.contains(CONTENT_WRAPPER_CLASS))
      return false
    return isTransNode(node)
  }

  const outerTransNodes = nodes.filter(isTransNode)
  if (outerTransNodes.length === 0) {
    return
  }

  // Preserve the selected element, or the shared parent of an inline/text
  // group, before unwrapping. Restoring a single paragraph's parent would
  // replace that paragraph and revert already translated siblings on retry.
  const originalContainer = outerTransNodes.length === 1 && isHTMLElement(outerTransNodes[0])
    ? outerTransNodes[0]
    : outerTransNodes[0].parentElement
  const hasExistingWrapper = originalContainer?.querySelector(`.${CONTENT_WRAPPER_CLASS}`)
  const originalContent = originalContainer && !originalContentMap.has(originalContainer) && !hasExistingWrapper
    ? originalContainer.innerHTML
    : null

  let transNodes: TransNode[] = []
  let allChildNodes: ChildNode[] = []
  if (outerTransNodes.length === 1 && isHTMLElement(outerTransNodes[0])) {
    const unwrappedHTMLChild = await unwrapDeepestOnlyHTMLChild(outerTransNodes[0])
    if (signal?.aborted)
      return
    allChildNodes = [...unwrappedHTMLChild.childNodes]
    transNodes = allChildNodes.filter(isTransNodeAndNotTranslatedWrapper)
  }
  else {
    transNodes = outerTransNodes
    allChildNodes = nodes
  }

  if (transNodes.length === 0) {
    return
  }

  const releaseNodes = acquireTranslationNodes(nodes, signal)
  if (!releaseNodes)
    return
  try {
    const targetNode = transNodes.at(-1)!

    const parentNode = targetNode.parentElement
    if (!parentNode) {
      console.error("targetNode.parentElement is not HTMLElement", targetNode.parentElement)
      return
    }
    const existedTranslatedWrapper = isHTMLElement(targetNode)
      ? findPreviousTranslatedWrapperInside(targetNode, walkId)
      : null
    const existedTranslatedWrapperOutside = targetNode.parentElement.closest(`.${CONTENT_WRAPPER_CLASS}`)
    const nextSibling = targetNode.nextSibling
    const adjacentTranslatedWrapper = nextSibling && isHTMLElement(nextSibling)
      && nextSibling.classList.contains(CONTENT_WRAPPER_CLASS)
      && nextSibling.getAttribute(WALKED_ATTRIBUTE) !== walkId
      ? nextSibling
      : null

    const finalTranslatedWrapper = existedTranslatedWrapperOutside ?? existedTranslatedWrapper ?? adjacentTranslatedWrapper
    if (finalTranslatedWrapper && isHTMLElement(finalTranslatedWrapper)) {
      removeTranslatedWrapperWithRestore(finalTranslatedWrapper)
      if (toggle) {
        return
      }
      else {
        // A selected paragraph stays attached when its innerHTML is restored;
        // unwrapping it again reads the recreated children for the retry.
        releaseNodes()
        await translateNodeTranslationOnlyMode(nodes, walkId, config, toggle, signal)
        return
      }
    }

    const innerTextContent = transNodes.map(node => extractTextContent(node, config)).join("")
    if (!innerTextContent.trim() || isNumericContent(innerTextContent))
      return

    if (await shouldFilterSmallParagraph(innerTextContent, config))
      return
    if (!isContentScriptActive() || signal?.aborted)
      return

    const cleanTextContent = (content: string): string => {
      if (!content)
        return content

      let cleanedContent = content.replace(MARK_ATTRIBUTES_REGEX, "")
      cleanedContent = cleanedContent.replace(HTML_COMMENT_RE, " ")

      return cleanedContent
    }

    const hasExistingWrapperInParent = parentNode.querySelector(`.${CONTENT_WRAPPER_CLASS}`)
    const parentOriginalContent = hasExistingWrapperInParent ? null : parentNode.innerHTML

    const getStringFormatFromNode = (node: Element | Text) => {
      if (isTextNode(node)) {
        return node.textContent
      }
      return node.outerHTML
    }

    const textContent = cleanTextContent(transNodes.map(getStringFormatFromNode).join(""))
    if (!textContent)
      return

    const ownerDoc = getOwnerDocument(targetNode)
    const translatedWrapperNode = ownerDoc.createElement("span")
    translatedWrapperNode.className = `${NOTRANSLATE_CLASS} ${CONTENT_WRAPPER_CLASS}`
    translatedWrapperNode.setAttribute(TRANSLATION_MODE_ATTRIBUTE, "translationOnly" satisfies TranslationMode)
    translatedWrapperNode.setAttribute(WALKED_ATTRIBUTE, walkId)
    translatedWrapperNode.style.display = "contents"
    setTranslationDirAndLang(translatedWrapperNode, config)
    const spinner = createSpinnerInside(translatedWrapperNode)
    bindTranslatedWrapperToSignal(translatedWrapperNode, signal)

    // Batch DOM insertion to reduce layout thrashing
    const insertOperation = () => {
      if (!isContentScriptActive() || signal?.aborted)
        return
      // An unattached wrapper needs no restoration. Commit the captured source
      // only when this session actually inserts its translation into the DOM.
      if (originalContainer && originalContent !== null && !originalContentMap.has(originalContainer)) {
        originalContentMap.set(originalContainer, originalContent)
      }
      if (parentOriginalContent !== null && !originalContentMap.has(parentNode)) {
        originalContentMap.set(parentNode, parentOriginalContent)
      }
      if (isTextNode(targetNode) || transNodes.length > 1) {
        targetNode.parentNode?.insertBefore(
          translatedWrapperNode,
          targetNode.nextSibling,
        )
      }
      else {
        targetNode.appendChild(translatedWrapperNode)
      }
    }
    batchDOMOperation(insertOperation)

    const realTranslatedText = await getTranslatedTextAndRemoveSpinner(nodes, textContent, spinner, translatedWrapperNode, signal)
    if (!isContentScriptActive() || signal?.aborted)
      return
    const translatedText = realTranslatedText ? getDisplayTranslation(textContent, realTranslatedText) : realTranslatedText

    if (!translatedText) {
      // Keep the wrapper when translation failed so the injected error UI remains visible.
      // Only remove the wrapper when translation returned an empty string.
      if (translatedText === "") {
        // Batch the remove operation to execute remove operation after insert operation
        batchDOMOperation(() => {
          removeShadowHostInTranslatedWrapper(translatedWrapperNode)
          translatedWrapperNode.remove()
        })
      }
      return
    }

    translatedWrapperNode.innerHTML = translatedText

    // Batch final DOM mutations to reduce layout thrashing
    batchDOMOperation(() => {
      if (!isContentScriptActive() || signal?.aborted)
        return
      // Insert translated content after the last node
      const lastChildNode = allChildNodes.at(-1)!
      lastChildNode.parentNode?.insertBefore(translatedWrapperNode, lastChildNode.nextSibling)

      // Remove all original nodes
      allChildNodes.forEach(childNode => childNode.remove())
    })
  }
  finally {
    releaseNodes()
  }
}
