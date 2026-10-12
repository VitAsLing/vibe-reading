import { MARK_ATTRIBUTES } from "../../../constants/dom-labels"

// State management for translation operations
export const translatingNodes = new WeakMap<ChildNode, symbol>()
export interface OriginalContentSnapshot {
  html: string
  dom: string
  identity: Node[]
  wrappers: Set<HTMLElement>
}

export const originalContentMap = new Map<HTMLElement, OriginalContentSnapshot>()

// Pre-compiled regex for better performance - removes all mark attributes
export const MARK_ATTRIBUTES_REGEX = new RegExp(`\\s*(?:${[...MARK_ATTRIBUTES].join("|")})(?:=['""][^'"]*['""]|=[^\\s>]*)?`, "g")
