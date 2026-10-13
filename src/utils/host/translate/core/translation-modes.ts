import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import type { TransNode } from "@/types/dom"
import { CONTENT_WRAPPER_CLASS, NOTRANSLATE_CLASS, TRANSLATION_MODE_ATTRIBUTE, WALKED_ATTRIBUTE } from "../../../constants/dom-labels"
import { batchDOMOperation } from "../../dom/batch-dom"
import { isBlockTransNode, isHTMLElement, isTextNode, isTransNode } from "../../dom/filter"
import { unwrapDeepestOnlyHTMLChild } from "../../dom/find"
import { getOwnerDocument } from "../../dom/node"
import { extractTextContent } from "../../dom/traversal"
import { removeShadowHostInTranslatedWrapper, removeTranslatedWrapperWithRestore } from "../dom/translation-cleanup"
import { insertTranslatedNodeIntoWrapper } from "../dom/translation-insertion"
import { findPreviousTranslatedWrapperInside } from "../dom/translation-wrapper"
import { shouldFilterSmallParagraph } from "../filter-small-paragraph"
import { prepareTranslationText } from "../text-preparation"
import { setTranslationDirAndLang } from "../translation-attributes"
import { createSpinnerInside, getTranslatedTextAndRemoveSpinner } from "../ui/spinner"
import { isNumericContent } from "../ui/translation-utils"
import { beginTranslationOperation } from "./translation-operations"
import { MARK_ATTRIBUTES_REGEX } from "./translation-state"

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

function getDisplayTranslation(sourceText: string, translatedText: string | undefined) {
  if (translatedText === undefined)
    return undefined
  return prepareTranslationText(sourceText) === prepareTranslationText(translatedText) ? "" : translatedText
}

export async function translateNodes(
  nodes: ChildNode[], walkId: string, toggle: boolean = false, config: Config,
  forceBlockTranslation: boolean = false, signal?: AbortSignal,
): Promise<void> {
  if (config.translate.mode === "translationOnly")
    await translateNodeTranslationOnlyMode(nodes, walkId, config, toggle, signal)
  else if (config.translate.mode === "bilingual")
    await translateNodesBilingualMode(nodes, walkId, config, toggle, forceBlockTranslation, signal)
}

export async function translateNodesBilingualMode(
  nodes: ChildNode[], walkId: string, config: Config, toggle: boolean = false,
  forceBlockTranslation: boolean = false, signal?: AbortSignal,
): Promise<void> {
  const transNodes = nodes.filter(isTransNode)
  if (transNodes.length === 0)
    return
  const operation = beginTranslationOperation(transNodes, signal)
  if (!operation)
    return
  try {
    const lastNode = transNodes.at(-1)!
    const targetNode = transNodes.length === 1 && isBlockTransNode(lastNode) && isHTMLElement(lastNode)
      ? operation.mutate(() => unwrapDeepestOnlyHTMLChild(lastNode, config, write => operation.mutate(write)))
      : lastNode
    if (!targetNode || !operation.isCurrent())
      return
    const existing = findPreviousTranslatedWrapperInside(targetNode, walkId)
    if (existing) {
      removeTranslatedWrapperWithRestore(existing)
      if (!toggle && !operation.scopeSignal.aborted) {
        operation.dispose(false)
        await translateNodesBilingualMode(nodes, walkId, config, toggle, forceBlockTranslation, operation.scopeSignal)
      }
      return
    }
    const textContent = transNodes.map(node => extractTextContent(node, config)).join("").trim()
    if (!textContent || isNumericContent(textContent) || await shouldFilterSmallParagraph(textContent, config))
      return
    if (!operation.isCurrent())
      return
    const wrapper = getOwnerDocument(targetNode).createElement("span")
    wrapper.className = `${NOTRANSLATE_CLASS} ${CONTENT_WRAPPER_CLASS}`
    wrapper.setAttribute(TRANSLATION_MODE_ATTRIBUTE, "bilingual" satisfies TranslationMode)
    wrapper.setAttribute(WALKED_ATTRIBUTE, walkId)
    setTranslationDirAndLang(wrapper, config)
    const spinner = createSpinnerInside(wrapper)
    operation.attachWrapper(wrapper)
    batchDOMOperation(() => {
      operation.mutate(() => {
        if (isTextNode(targetNode) || transNodes.length > 1)
          targetNode.parentNode?.insertBefore(wrapper, targetNode.nextSibling)
        else
          targetNode.appendChild(wrapper)
      })
    })
    const realText = await getTranslatedTextAndRemoveSpinner(nodes, textContent, spinner, wrapper, operation)
    if (!operation.isCurrent())
      return
    const translated = getDisplayTranslation(textContent, realText)
    if (!translated) {
      if (translated === "")
        batchDOMOperation(() => removeShadowHostInTranslatedWrapper(wrapper))
      return
    }
    await operation.mutate(() => insertTranslatedNodeIntoWrapper(wrapper, targetNode, translated, config.translate.translationNodeStyle, forceBlockTranslation))
  }
  finally {
    operation.finish()
  }
}

export async function translateNodeTranslationOnlyMode(
  nodes: ChildNode[], walkId: string, config: Config, toggle: boolean = false, signal?: AbortSignal,
): Promise<void> {
  const outerNodes = nodes.filter(isTransNode)
  if (outerNodes.length === 0)
    return
  const operation = beginTranslationOperation(nodes, signal)
  if (!operation)
    return
  try {
    let allChildren: ChildNode[] = nodes
    const outerNode = outerNodes[0]
    if (outerNodes.length === 1 && isHTMLElement(outerNode)) {
      const unwrapped = operation.mutate(() => unwrapDeepestOnlyHTMLChild(outerNode, config, write => operation.mutate(write)))
      if (!unwrapped || !operation.isCurrent())
        return
      allChildren = [...unwrapped.childNodes]
    }
    const transNodes = allChildren.filter((node): node is TransNode => isTransNode(node)
      && !(isHTMLElement(node) && node.classList.contains(CONTENT_WRAPPER_CLASS)))
    if (transNodes.length === 0)
      return
    const targetNode = transNodes.at(-1)!
    const parent = targetNode.parentElement
    if (!parent || !operation.isCurrent())
      return
    const inside = isHTMLElement(targetNode) ? findPreviousTranslatedWrapperInside(targetNode, walkId) : null
    const outside = parent.closest<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)
    const sibling = targetNode.nextSibling
    const adjacent = sibling && isHTMLElement(sibling) && sibling.classList.contains(CONTENT_WRAPPER_CLASS)
      && sibling.getAttribute(WALKED_ATTRIBUTE) !== walkId
      ? sibling
      : null
    const existing = outside ?? inside ?? adjacent
    if (existing) {
      removeTranslatedWrapperWithRestore(existing)
      if (!toggle && !operation.scopeSignal.aborted) {
        operation.dispose(false)
        await translateNodeTranslationOnlyMode(nodes, walkId, config, toggle, operation.scopeSignal)
      }
      return
    }
    const plainText = transNodes.map(node => extractTextContent(node, config)).join("")
    if (!plainText.trim() || isNumericContent(plainText) || await shouldFilterSmallParagraph(plainText, config))
      return
    if (!operation.isCurrent())
      return
    const textContent = transNodes.map(node => isTextNode(node) ? node.textContent : node.outerHTML).join("").replace(MARK_ATTRIBUTES_REGEX, "").replace(HTML_COMMENT_RE, " ")
    if (!textContent)
      return
    const wrapper = getOwnerDocument(targetNode).createElement("span")
    wrapper.className = `${NOTRANSLATE_CLASS} ${CONTENT_WRAPPER_CLASS}`
    wrapper.setAttribute(TRANSLATION_MODE_ATTRIBUTE, "translationOnly" satisfies TranslationMode)
    wrapper.setAttribute(WALKED_ATTRIBUTE, walkId)
    wrapper.style.display = "contents"
    setTranslationDirAndLang(wrapper, config)
    const spinner = createSpinnerInside(wrapper)
    operation.attachWrapper(wrapper)
    batchDOMOperation(() => {
      operation.mutate(() => {
        if (isTextNode(targetNode) || transNodes.length > 1)
          targetNode.parentNode?.insertBefore(wrapper, targetNode.nextSibling)
        else
          targetNode.appendChild(wrapper)
        // One source owner, committed only after a valid DOM insertion.
        operation.commitSnapshot()
      })
    })
    const realText = await getTranslatedTextAndRemoveSpinner(nodes, textContent, spinner, wrapper, operation)
    if (!operation.isCurrent())
      return
    const translated = realText ? getDisplayTranslation(textContent, realText) : realText
    if (!translated) {
      if (translated === "")
        batchDOMOperation(() => removeShadowHostInTranslatedWrapper(wrapper))
      return
    }
    operation.mutate(() => {
      wrapper.innerHTML = translated
    })
    batchDOMOperation(() => {
      operation.mutate(() => {
        const last = allChildren.at(-1)!
        last.parentNode?.insertBefore(wrapper, last.nextSibling)
        operation.retainReplacedSource(allChildren)
        allChildren.forEach(node => node.remove())
      })
    })
  }
  finally {
    operation.finish()
  }
}
