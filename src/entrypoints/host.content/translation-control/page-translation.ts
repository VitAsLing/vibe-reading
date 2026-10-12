import type { Config } from "@/types/config/config"
import { isLLMProviderConfig } from "@/types/config/provider"
import { getLocalConfig } from "@/utils/config/storage"
import { CONTENT_WRAPPER_CLASS } from "@/utils/constants/dom-labels"
import { resolveProviderConfig } from "@/utils/constants/feature-providers"
import { isContentScriptActive, reportContentScriptError, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { hasNoWalkAncestor, isDontWalkIntoAndDontTranslateAsChildElement, isDontWalkIntoButTranslateAsChildElement, isHTMLElement } from "@/utils/host/dom/filter"
import { deepQueryTopLevelSelector } from "@/utils/host/dom/find"
import { walkAndLabelElement } from "@/utils/host/dom/traversal"
import { cancelDocumentTranslations, getDocumentTranslationSignal } from "@/utils/host/translate/core/translation-operations"
import { removeAllTranslatedWrapperNodes, translateWalkedElement } from "@/utils/host/translate/node-manipulation"
import { validateTranslationConfigAndToast } from "@/utils/host/translate/translate-text"
import { translateTextForPageTitle } from "@/utils/host/translate/translate-variants"
import { getOrCreateWebPageContext } from "@/utils/host/translate/webpage-context"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"

type SimpleIntersectionOptions = Omit<IntersectionObserverInit, "threshold"> & {
  threshold?: number
}

export class PageTranslationManager {
  private static readonly MAX_DURATION = 500
  private static readonly MOVE_THRESHOLD = 30 * 30
  private static readonly DEFAULT_INTERSECTION_OPTIONS: SimpleIntersectionOptions = {
    root: null,
    rootMargin: "600px",
    threshold: 0.1,
  }

  private disposed = false
  private isStarting = false
  private startPromise: Promise<void> | null = null
  private sessionVersion = 0
  private isPageTranslating: boolean = false
  private intersectionObserver: IntersectionObserver | null = null
  private mutationObservers: MutationObserver[] = []
  private walkId: string | null = null
  private intersectionOptions: IntersectionObserverInit
  private walkBlockedElementsCache = new WeakSet<HTMLElement>()
  private titleObserver: MutationObserver | null = null
  private lastSourceTitle: string | null = null
  private lastAppliedTranslatedTitle: string | null = null
  private titleRequestVersion = 0

  constructor(intersectionOptions: SimpleIntersectionOptions = {}) {
    if (intersectionOptions.threshold !== undefined) {
      if (intersectionOptions.threshold < 0 || intersectionOptions.threshold > 1) {
        throw new Error("IntersectionObserver threshold must be between 0 and 1")
      }
    }

    this.intersectionOptions = {
      ...PageTranslationManager.DEFAULT_INTERSECTION_OPTIONS,
      ...intersectionOptions,
    }
  }

  get isActive(): boolean {
    return this.isPageTranslating || this.isStarting
  }

  get isEnabled(): boolean {
    return this.isPageTranslating
  }

  async start(): Promise<void> {
    if (this.disposed || !isContentScriptActive())
      return
    if (this.startPromise) {
      await this.startPromise
      return
    }
    if (this.isPageTranslating)
      return

    const version = ++this.sessionVersion
    const signal = getDocumentTranslationSignal()
    this.isStarting = true
    const task = this.startSession(version, signal).catch((error) => {
      if (version === this.sessionVersion)
        this.stopInternal({ notify: isContentScriptActive() })
      throw error
    }).finally(() => {
      if (version === this.sessionVersion) {
        this.isStarting = false
        this.startPromise = null
      }
    })
    this.startPromise = task
    await task
  }

  private isCurrentSession(version: number): boolean {
    return !this.disposed && isContentScriptActive() && version === this.sessionVersion
  }

  private isCurrentWalk(walkId: string | null): boolean {
    return !!walkId && this.isPageTranslating && !this.disposed
      && isContentScriptActive() && this.walkId === walkId
  }

  private async startSession(version: number, signal: AbortSignal): Promise<void> {
    const config = await getLocalConfig()
    if (!this.isCurrentSession(version))
      return
    if (!config) {
      console.warn("Config is not initialized")
      return
    }

    if (!validateTranslationConfigAndToast({
      providersConfig: config.providersConfig,
      translate: config.translate,
      language: config.language,
    })) {
      return
    }

    const providerConfig = resolveProviderConfig(config, "translate")
    const accepted = await sendMessage("setAndNotifyPageTranslationStateChangedByManager", {
      enabled: true,
      url: window.location.href,
    })
    if (accepted !== true || !this.isCurrentSession(version))
      return

    this.isPageTranslating = true
    await this.primeDocumentTitleContext(
      config.translate.enableAIContentAware && isLLMProviderConfig(providerConfig),
    )
    if (!this.isCurrentSession(version))
      return
    this.startDocumentTitleTracking()

    const walkId = getRandomUUID()
    this.walkId = walkId
    this.intersectionObserver = new IntersectionObserver((entries, observer) => {
      runContentScriptTask(async () => {
        for (const entry of entries) {
          if (!this.isCurrentWalk(walkId))
            return
          if (entry.isIntersecting) {
            if (isHTMLElement(entry.target) && !entry.target.closest(`.${CONTENT_WRAPPER_CLASS}`)) {
              const currentConfig = await getLocalConfig()
              if (!this.isCurrentWalk(walkId))
                return
              if (!currentConfig) {
                logger.error("Global config is not initialized")
                return
              }
              runContentScriptTask(
                () => translateWalkedElement(entry.target as HTMLElement, walkId, currentConfig, false, signal),
                "Failed to translate a page paragraph:",
              )
            }
            observer.unobserve(entry.target)
          }
        }
      }, "Failed to observe page translation:")
    }, this.intersectionOptions)

    this.addWalkBlockedElements(document.body, config)
    await this.observeTopLevelParagraphs(document.body, config)
    if (this.isCurrentSession(version)) {
      this.observeMutations(document.body)
    }
  }

  stop(): void {
    this.stopInternal({ notify: true })
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.stopInternal({ notify: false })
  }

  async restart(): Promise<void> {
    if (this.disposed || !isContentScriptActive())
      return
    if (!this.isActive) {
      await this.start()
      return
    }

    this.stopInternal({ notify: false })
    await this.start()
  }

  private stopInternal({ notify }: { notify: boolean }): void {
    const wasActive = this.isActive
    this.sessionVersion++
    this.isStarting = false
    this.startPromise = null
    this.isPageTranslating = false
    cancelDocumentTranslations()

    if (notify && wasActive) {
      runContentScriptTask(() => sendMessage("setAndNotifyPageTranslationStateChangedByManager", {
        enabled: false,
        url: window.location.href,
      }), "Failed to stop page translation:")
    }

    this.walkId = null
    this.walkBlockedElementsCache = new WeakSet()
    this.stopDocumentTitleTracking()

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect()
      this.intersectionObserver = null
    }
    this.mutationObservers.forEach(observer => observer.disconnect())
    this.mutationObservers = []

    removeAllTranslatedWrapperNodes()
  }

  registerPageTranslationTriggers(): () => void {
    let startTime = 0
    let startTouches: TouchList | null = null

    const reset = () => {
      startTime = 0
      startTouches = null
    }

    const onStart = (e: TouchEvent) => {
      if (!isContentScriptActive() || this.disposed)
        return
      if (e.touches.length === 4) {
        startTime = performance.now()
        startTouches = e.touches
      }
      else {
        reset()
      }
    }

    const onMove = (e: TouchEvent) => {
      if (!startTouches)
        return
      if (e.touches.length !== 4)
        return reset()

      for (let i = 0; i < 4; i++) {
        const dx = e.touches[i].clientX - startTouches[i].clientX
        const dy = e.touches[i].clientY - startTouches[i].clientY
        if (dx * dx + dy * dy > PageTranslationManager.MOVE_THRESHOLD)
          return reset()
      }
    }

    const onEnd = () => {
      if (!isContentScriptActive() || this.disposed)
        return
      if (!startTouches)
        return
      if (performance.now() - startTime < PageTranslationManager.MAX_DURATION) {
        this.isActive
          ? this.stop()
          : runContentScriptTask(() => this.start(), "Failed to start page translation:")
      }
      reset()
    }

    document.addEventListener("touchstart", onStart, { passive: true })
    document.addEventListener("touchmove", onMove, { passive: true })
    document.addEventListener("touchend", onEnd, { passive: true })
    document.addEventListener("touchcancel", reset, { passive: true })

    // Teardown: remove all touch listeners
    return () => {
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchmove", onMove)
      document.removeEventListener("touchend", onEnd)
      document.removeEventListener("touchcancel", reset)
    }
  }

  private shouldManageDocumentTitle(): boolean {
    return window === window.top
  }

  private async primeDocumentTitleContext(shouldPrimeWebPageContext: boolean): Promise<void> {
    if (!this.shouldManageDocumentTitle() || !shouldPrimeWebPageContext) {
      return
    }

    try {
      await getOrCreateWebPageContext()
    }
    catch (error) {
      logger.warn("Failed to prime webpage context before translating document title:", error)
    }
  }

  private startDocumentTitleTracking(): void {
    if (!this.shouldManageDocumentTitle()) {
      return
    }

    this.lastSourceTitle = document.title || ""
    this.lastAppliedTranslatedTitle = null

    this.observeDocumentTitle()
    void this.syncDocumentTitle(this.lastSourceTitle)
  }

  private stopDocumentTitleTracking(): void {
    if (!this.shouldManageDocumentTitle()) {
      return
    }

    const currentTitle = document.title || ""
    if (currentTitle !== this.lastAppliedTranslatedTitle) {
      this.lastSourceTitle = currentTitle
    }

    if (this.titleObserver) {
      this.titleObserver.disconnect()
      this.titleObserver = null
    }

    this.titleRequestVersion++

    if (this.lastSourceTitle !== null && document.title !== this.lastSourceTitle) {
      document.title = this.lastSourceTitle
    }

    this.lastSourceTitle = null
    this.lastAppliedTranslatedTitle = null
  }

  private observeDocumentTitle(): void {
    if (!document.head) {
      return
    }

    if (this.titleObserver) {
      this.titleObserver.disconnect()
    }

    this.titleObserver = new MutationObserver(() => {
      this.handleDocumentTitleMutation()
    })

    this.titleObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  private handleDocumentTitleMutation(): void {
    if (!isContentScriptActive() || !this.isPageTranslating || !this.shouldManageDocumentTitle()) {
      return
    }

    const currentTitle = document.title || ""

    if (currentTitle === this.lastSourceTitle) {
      return
    }

    if (currentTitle === this.lastAppliedTranslatedTitle) {
      return
    }

    this.lastSourceTitle = currentTitle
    void this.syncDocumentTitle(currentTitle)
  }

  private async syncDocumentTitle(sourceTitle: string): Promise<void> {
    if (!isContentScriptActive() || !sourceTitle.trim() || !this.isPageTranslating || !this.shouldManageDocumentTitle()) {
      return
    }

    const requestVersion = ++this.titleRequestVersion

    try {
      const translatedTitle = await translateTextForPageTitle(sourceTitle)
      if (!isContentScriptActive() || !this.isPageTranslating || requestVersion !== this.titleRequestVersion) {
        return
      }

      const nextTitle = translatedTitle || sourceTitle
      this.lastAppliedTranslatedTitle = nextTitle

      if (document.title === nextTitle) {
        return
      }

      document.title = nextTitle
    }
    catch (error) {
      if (requestVersion === this.titleRequestVersion) {
        reportContentScriptError("Failed to translate document title:", error)
      }
    }
  }

  private async observeTopLevelParagraphs(container: HTMLElement, existingConfig?: Config): Promise<void> {
    const observer = this.intersectionObserver
    const walkId = this.walkId
    if (!walkId || !this.isCurrentWalk(walkId) || !observer)
      return

    const config = existingConfig ?? await getLocalConfig()
    if (!this.isCurrentWalk(walkId))
      return
    if (!config) {
      logger.error("Global config is not initialized")
      return
    }

    // Skip if container has an ancestor that should not be walked into
    if (hasNoWalkAncestor(container, config))
      return

    walkAndLabelElement(container, walkId, config)
    // if container itself has paragraph and the id
    if (container.hasAttribute("data-vibe-reading-paragraph") && container.getAttribute("data-vibe-reading-walked") === walkId) {
      observer.observe(container)
      return
    }

    const paragraphs = this.collectParagraphElementsDeep(container, walkId)
    const topLevelParagraphs = paragraphs.filter((el) => {
      const ancestor = el.parentElement?.closest("[data-vibe-reading-paragraph]")
      // keep it if either:
      //  • no paragraph ancestor at all, or
      //  • the ancestor is *not* inside container
      return !ancestor || !container.contains(ancestor)
    })
    topLevelParagraphs.forEach(el => observer.observe(el))
  }

  /**
   * Recursively collect elements with paragraph attributes from shadow roots and iframes
   */
  private collectParagraphElementsDeep(container: HTMLElement, walkId: string): HTMLElement[] {
    const result: HTMLElement[] = []

    const collectFromContainer = (root: HTMLElement | Document | ShadowRoot) => {
      const elements = root.querySelectorAll<HTMLElement>(`[data-vibe-reading-paragraph][data-vibe-reading-walked="${CSS.escape(walkId)}"]`)
      result.push(...[...elements])
    }

    const traverseElement = (element: HTMLElement) => {
      if (element.shadowRoot) {
        collectFromContainer(element.shadowRoot)
        for (const child of element.shadowRoot.children) {
          if (child instanceof HTMLElement) {
            traverseElement(child)
          }
        }
      }

      for (const child of element.children) {
        if (child instanceof HTMLElement) {
          traverseElement(child)
        }
      }
    }

    collectFromContainer(container)
    traverseElement(container)

    return result
  }

  /**
   * Track the same blocked states that the traversal skips, so hidden accordion
   * panels can be re-walked when the site reveals an existing subtree.
   */
  private isWalkBlockedElement(element: HTMLElement, config: Config): boolean {
    return isDontWalkIntoButTranslateAsChildElement(element)
      || isDontWalkIntoAndDontTranslateAsChildElement(element, config)
  }

  /**
   * Handle attribute changes and only trigger observation
   * when element transitions from blocked to walkable.
   */
  private didChangeToWalkable(element: HTMLElement, config: Config): boolean {
    const wasWalkBlocked = this.walkBlockedElementsCache.has(element)
    const isWalkBlockedNow = this.isWalkBlockedElement(element, config)

    // Update cache with current state
    if (isWalkBlockedNow) {
      this.walkBlockedElementsCache.add(element)
    }
    else {
      this.walkBlockedElementsCache.delete(element)
    }

    return wasWalkBlocked === true && isWalkBlockedNow === false
  }

  /**
   * Initialize walkability state for an element and its descendants
   */
  private addWalkBlockedElements(element: HTMLElement, config: Config): void {
    const walkBlockedElements = deepQueryTopLevelSelector(element, el => this.isWalkBlockedElement(el, config))
    walkBlockedElements.forEach(el => this.walkBlockedElementsCache.add(el))
  }

  /**
   * Start observing mutations for a container and all its shadow roots
   */
  private observeMutations(container: HTMLElement): void {
    const walkId = this.walkId
    if (!this.isCurrentWalk(walkId))
      return
    const mutationObserver = new MutationObserver((records) => {
      runContentScriptTask(() => this.handleMutationRecords(records, walkId), "Failed to handle page mutations:")
    })

    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"],
    })

    this.mutationObservers.push(mutationObserver)
    this.observeIsolatedDescendantsMutations(container)
  }

  private async handleMutationRecords(records: MutationRecord[], walkId: string | null): Promise<void> {
    if (!this.isCurrentWalk(walkId))
      return
    const config = await getLocalConfig()
    if (!this.isCurrentWalk(walkId))
      return
    if (!config) {
      logger.error("Global config is not initialized")
      return
    }

    for (const rec of records) {
      if (rec.type === "childList") {
        for (const node of rec.addedNodes) {
          if (isHTMLElement(node)) {
            this.addWalkBlockedElements(node, config)
            await this.observeTopLevelParagraphs(node, config)
            if (!this.isCurrentWalk(walkId))
              return
            this.observeIsolatedDescendantsMutations(node)
          }
        }
      }
      else if (this.isWalkabilityAttributeMutation(rec)) {
        const el = rec.target
        if (isHTMLElement(el) && this.didChangeToWalkable(el, config)) {
          await this.observeTopLevelParagraphs(el, config)
          if (!this.isCurrentWalk(walkId))
            return
        }
      }
    }
  }

  private isWalkabilityAttributeMutation(record: MutationRecord): boolean {
    return record.type === "attributes"
      && (record.attributeName === "style"
        || record.attributeName === "class"
        || record.attributeName === "hidden"
        || record.attributeName === "aria-hidden")
  }

  /**
   * Recursively find and observe shadow roots and iframes in an element and its descendants
   * These can't be found as top level paragraph elements because isolated shadow roots and iframes are not
   * considered as part of the document.
   */
  private observeIsolatedDescendantsMutations(element: HTMLElement): void {
    // Check if this element has a shadow root
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) {
        if (isHTMLElement(child)) {
          this.observeMutations(child)
        }
      }
    }

    // Recursively check children
    for (const child of element.children) {
      if (isHTMLElement(child)) {
        this.observeIsolatedDescendantsMutations(child)
      }
    }
  }
}
