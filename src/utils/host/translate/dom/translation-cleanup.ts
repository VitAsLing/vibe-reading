import { isTranslatedWrapperNode } from "../../dom/filter"
import { deepQueryTopLevelSelector } from "../../dom/find"
import { discardTranslationWrapper, restoreTranslationWrapper } from "../core/translation-operations"

export function removeShadowHostInTranslatedWrapper(wrapper: HTMLElement): void {
  discardTranslationWrapper(wrapper)
}

export function removeTranslatedWrapperWithRestore(wrapper: HTMLElement): void {
  restoreTranslationWrapper(wrapper)
}

export function removeAllTranslatedWrapperNodes(root: Document | ShadowRoot = document): void {
  deepQueryTopLevelSelector(root, isTranslatedWrapperNode).forEach(removeTranslatedWrapperWithRestore)
}
