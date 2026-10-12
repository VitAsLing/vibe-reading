import { CONTENT_WRAPPER_CLASS, REACT_SHADOW_HOST_CLASS } from "@/utils/constants/dom-labels"
import { isContentScriptActive } from "@/utils/content-script/lifecycle"
import { removeReactShadowHost } from "@/utils/react-shadow-host/create-shadow-host"
import { isHTMLElement } from "../../dom/filter"
import { originalContentMap, translatingNodes } from "./translation-state"

let documentController = new AbortController()
let sourceObserver: MutationObserver | null = null
let sweeping = false
const operations = new Set<TranslationOperation>()
const wrapperOperations = new WeakMap<HTMLElement, TranslationOperation>()
const shadowRoots = new Map<ShadowRoot, number>()

function domState(owner: HTMLElement): string {
  const clone = owner.cloneNode(true) as HTMLElement
  for (const wrapper of [...clone.querySelectorAll(`.${CONTENT_WRAPPER_CLASS}`)]) {
    wrapper.replaceWith(owner.ownerDocument.createComment("translation"))
  }
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith("data-vibe-reading-"))
        node.removeAttribute(attribute.name)
    }
  }
  return clone.innerHTML
}

function domIdentity(owner: HTMLElement): Node[] {
  const nodes: Node[] = []
  const visit = (container: Node) => {
    for (const child of container.childNodes) {
      nodes.push(child)
      // A translation owns this capsule's contents. The source tree includes
      // the capsule identity and position, but not its spinner or error portal.
      if (!(isHTMLElement(child) && child.classList.contains(CONTENT_WRAPPER_CLASS)))
        visit(child)
    }
  }
  visit(owner)
  return nodes
}

function sameIdentity(expected: Node[], current: Node[]): boolean {
  return expected.length === current.length && expected.every((node, index) => node === current[index])
}

function snapshotMatches(owner: HTMLElement): boolean {
  const snapshot = originalContentMap.get(owner)
  return !!snapshot && owner.isConnected && snapshot.dom === domState(owner)
    && sameIdentity(snapshot.identity, domIdentity(owner))
    && [...snapshot.wrappers].some(wrapper => owner.contains(wrapper))
}

function originalHTML(owner: HTMLElement): string {
  const clone = owner.cloneNode(true) as HTMLElement
  const visit = (source: Element, target: Element) => {
    if (source !== owner && isHTMLElement(source) && snapshotMatches(source)) {
      target.innerHTML = originalContentMap.get(source)!.html
      return
    }
    const sourceChildren = [...source.children]
    const targetChildren = [...target.children]
    sourceChildren.forEach((child, index) => visit(child, targetChildren[index]))
  }
  visit(owner, clone)
  clone.querySelectorAll(`.${CONTENT_WRAPPER_CLASS}`).forEach(wrapper => wrapper.remove())
  return clone.innerHTML
}

function updateOwnedDOM(owner: HTMLElement, action: () => void): void {
  action()
  const states = new Map<HTMLElement, { dom: string, identity: Node[] }>()
  const state = (container: HTMLElement) => {
    if (!states.has(container))
      states.set(container, { dom: domState(container), identity: domIdentity(container) })
    return states.get(container)!
  }
  for (const operation of operations) {
    if (owner.contains(operation.owner) || operation.owner.contains(owner)) {
      const expected = state(operation.owner)
      operation.expectedDOM = expected.dom
      operation.expectedIdentity = expected.identity
    }
  }
  for (const [container, snapshot] of originalContentMap) {
    if (owner.contains(container) || container.contains(owner)) {
      const expected = state(container)
      snapshot.dom = expected.dom
      snapshot.identity = expected.identity
    }
  }
}

function releaseUnusedSnapshots(): void {
  for (const [owner, snapshot] of originalContentMap) {
    if (!owner.isConnected || ![...snapshot.wrappers].some(wrapper => owner.contains(wrapper))) {
      originalContentMap.delete(owner)
    }
  }
}

function observeSources(): void {
  if (!sourceObserver)
    return
  const pending = sourceObserver.takeRecords()
  if (pending.length && !sweeping)
    sweepSources(pending)
  sourceObserver.disconnect()
  for (const root of [document, ...shadowRoots.keys()]) {
    sourceObserver.observe(root, { childList: true, characterData: true, subtree: true, attributes: true })
  }
}

function related(owner: HTMLElement, records: MutationRecord[]): boolean {
  if (!owner.isConnected)
    return true
  return records.some((record) => {
    if (record.type === "attributes" && record.attributeName?.startsWith("data-vibe-reading-"))
      return false
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    if (target?.closest(`.${CONTENT_WRAPPER_CLASS}`))
      return false
    return owner.contains(record.target) || (record.type === "childList"
      && [...record.removedNodes, ...record.addedNodes].some(node => node.contains(owner)))
  })
}

function sweepSources(records?: MutationRecord[], owner?: HTMLElement): void {
  if (sweeping)
    return
  sweeping = true
  try {
    const relevant = (container: HTMLElement) => owner
      ? container === owner || container.contains(owner) || owner.contains(container)
      : !records || related(container, records)
    const states = new Map<HTMLElement, { dom: string, identity: Node[] }>()
    const state = (container: HTMLElement) => {
      if (!states.has(container))
        states.set(container, { dom: domState(container), identity: domIdentity(container) })
      return states.get(container)!
    }
    // Check related owners before cleanup, without cloning unrelated paragraphs.
    const invalid = [...operations].filter(operation => relevant(operation.owner)
      && !operation.sourceMatches(operation.owner.isConnected ? state(operation.owner) : undefined))
    const staleSnapshots = [...originalContentMap].filter(([container, snapshot]) => relevant(container)
      && (!container.isConnected || snapshot.dom !== state(container).dom
        || !sameIdentity(snapshot.identity, state(container).identity)
        || ![...snapshot.wrappers].some(wrapper => container.contains(wrapper))))
    invalid.forEach(operation => operation.dispose(true))
    for (const [container, snapshot] of staleSnapshots) {
      if (originalContentMap.get(container) === snapshot)
        originalContentMap.delete(container)
    }
    releaseUnusedSnapshots()
  }
  finally {
    sweeping = false
  }
}

export function initializeTranslationOperations(): () => void {
  sourceObserver = new MutationObserver(records => sweepSources(records))
  observeSources()
  return () => {
    documentController.abort()
    sourceObserver?.disconnect()
    sourceObserver = null
  }
}

export function getDocumentTranslationSignal(): AbortSignal {
  return documentController.signal
}

export function cancelDocumentTranslations(): void {
  documentController.abort()
  documentController = new AbortController()
}

function removeReactUI(wrapper: HTMLElement): void {
  for (const host of wrapper.querySelectorAll<HTMLElement>(`.${REACT_SHADOW_HOST_CLASS}`)) {
    removeReactShadowHost(host)
  }
  wrapper.querySelector(".vibe-reading-spinner")?.remove()
}

export class TranslationOperation {
  readonly token = Symbol("translation operation")
  readonly original: string
  expectedDOM: string
  expectedIdentity: Node[]
  wrapper: HTMLElement | null = null
  private disposed = false
  private inserted = false
  private replacedSource: ChildNode[] | null = null
  private sourceMarkup: string[] = []
  private readonly ownerParent: ParentNode | null
  private readonly sourceRoot: Node
  private readonly abortScope = () => {
    if (this.wrapper && this.sourceMatches() && snapshotMatches(this.owner))
      restoreTranslationWrapper(this.wrapper)
    else
      this.dispose(!this.sourceMatches())
  }

  constructor(readonly owner: HTMLElement, readonly nodes: ChildNode[], readonly scopeSignal: AbortSignal) {
    this.original = originalHTML(owner)
    this.expectedDOM = domState(owner)
    this.expectedIdentity = domIdentity(owner)
    this.ownerParent = owner.parentNode
    this.sourceRoot = owner.getRootNode()
    nodes.forEach(node => translatingNodes.set(node, this.token))
    scopeSignal.addEventListener("abort", this.abortScope, { once: true })
    operations.add(this)
    if (this.sourceRoot instanceof ShadowRoot) {
      const count = shadowRoots.get(this.sourceRoot) ?? 0
      shadowRoots.set(this.sourceRoot, count + 1)
      if (count === 0)
        observeSources()
    }
  }

  sourceMatches(state?: { dom: string, identity: Node[] }): boolean {
    return !this.disposed && this.owner.isConnected && this.owner.parentNode === this.ownerParent
      && (!this.inserted || (!!this.wrapper && this.owner.contains(this.wrapper)))
      && (state?.dom ?? domState(this.owner)) === this.expectedDOM
      && sameIdentity(this.expectedIdentity, state?.identity ?? domIdentity(this.owner))
  }

  isCurrent(): boolean {
    sweepSources(undefined, this.owner)
    return !this.disposed && !this.scopeSignal.aborted && isContentScriptActive()
  }

  mutate<T>(action: () => T): T | undefined {
    if (!this.isCurrent())
      return undefined
    let result: T | undefined
    updateOwnedDOM(this.owner, () => {
      result = action()
    })
    if (this.wrapper?.isConnected)
      this.inserted = true
    return result
  }

  attachWrapper(wrapper: HTMLElement): void {
    this.wrapper = wrapper
    wrapperOperations.set(wrapper, this)
  }

  commitSnapshot(): void {
    if (!this.wrapper || !this.owner.contains(this.wrapper))
      return
    let snapshot = originalContentMap.get(this.owner)
    if (!snapshot) {
      snapshot = { html: this.original, dom: domState(this.owner), identity: domIdentity(this.owner), wrappers: new Set() }
      originalContentMap.set(this.owner, snapshot)
    }
    snapshot.wrappers.add(this.wrapper)
  }

  retainReplacedSource(nodes: ChildNode[]): void {
    this.replacedSource = [...nodes]
    this.sourceMarkup = nodes.map(node => node instanceof Element ? node.outerHTML : node.textContent ?? "")
  }

  private releaseNodes(): void {
    for (const node of this.nodes) {
      if (translatingNodes.get(node) === this.token)
        translatingNodes.delete(node)
    }
  }

  finish(): void {
    this.releaseNodes()
    if (!this.wrapper)
      this.dispose(false)
  }

  dispose(sourceChanged: boolean): void {
    if (this.disposed)
      return
    this.disposed = true
    this.scopeSignal.removeEventListener("abort", this.abortScope)
    this.releaseNodes()
    operations.delete(this)
    const wrapper = this.wrapper
    if (wrapper) {
      wrapperOperations.delete(wrapper)
      updateOwnedDOM(this.owner, () => {
        // A different group in this owner may change while our completed group
        // still owns its wrapper. Restore only the unchanged nodes we removed,
        // never an obsolete owner-wide HTML snapshot over the site's new text.
        if (sourceChanged && this.owner.contains(wrapper) && this.replacedSource
          && this.replacedSource.every((node, index) => !node.parentNode
            && (node instanceof Element ? node.outerHTML : node.textContent ?? "") === this.sourceMarkup[index])) {
          wrapper.before(...this.replacedSource)
        }
        removeReactUI(wrapper)
        wrapper.remove()
      })
      originalContentMap.get(this.owner)?.wrappers.delete(wrapper)
    }
    releaseUnusedSnapshots()
    if (this.sourceRoot instanceof ShadowRoot) {
      const count = shadowRoots.get(this.sourceRoot)! - 1
      if (count === 0) {
        shadowRoots.delete(this.sourceRoot)
        observeSources()
      }
      else {
        shadowRoots.set(this.sourceRoot, count)
      }
    }
  }
}

export function beginTranslationOperation(nodes: ChildNode[], scopeSignal = getDocumentTranslationSignal()): TranslationOperation | null {
  const first = nodes[0]
  const owner = nodes.length === 1 && first && isHTMLElement(first) ? first : first?.parentElement
  if (owner)
    sweepSources(undefined, owner)
  if (!owner?.isConnected || scopeSignal.aborted || nodes.every(node => translatingNodes.has(node)))
    return null
  return new TranslationOperation(owner, nodes, scopeSignal)
}

export function discardTranslationWrapper(wrapper: HTMLElement): void {
  const operation = wrapperOperations.get(wrapper)
  if (operation) {
    operation.dispose(false)
  }
  else {
    removeReactUI(wrapper)
    wrapper.remove()
  }
}

export function restoreTranslationWrapper(wrapper: HTMLElement): void {
  const operation = wrapperOperations.get(wrapper)
  const owner = operation?.owner
  const snapshot = owner ? originalContentMap.get(owner) : undefined
  if (!owner || !snapshot || !snapshotMatches(owner)) {
    operation?.dispose(true)
    discardTranslationWrapper(wrapper)
    return
  }
  const html = snapshot.html
  originalContentMap.delete(owner)
  // Restoring an owner also replaces nested groups; release their UI and locks
  // before replacing the DOM, while leaving adjacent owners untouched.
  for (const candidate of [...operations]) {
    if (candidate.owner === owner || owner.contains(candidate.owner))
      candidate.dispose(false)
  }
  updateOwnedDOM(owner, () => {
    owner.innerHTML = html
  })
  releaseUnusedSnapshots()
}
