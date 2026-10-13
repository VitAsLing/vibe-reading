import type { LangCodeISO6393 } from "@/definitions"
import { browser, storage } from "#imports"
import { normalizeDetectedCode } from "@/utils/config/languages"
import { DEFAULT_DETECTED_CODE } from "@/utils/constants/config"
import { getDetectedCodeStateKey, getTranslationStateKey } from "@/utils/constants/storage-keys"
import { logger } from "@/utils/logger"
import { onMessage, sendMessage } from "@/utils/message"
import { injectHostContentIntoCurrentTabIframesAfterNodeTranslation, injectHostContentIntoTabIframes } from "./iframe-injection"
import {
  getPageTranslationState,
  isPageTranslationStateInUrlScope,
  setPageTranslationEnabled,
} from "./page-translation-state"

const pageStateOperations = new Map<number, symbol>()
const languageOperations = new Map<number, symbol>()

function beginTabOperation(operations: Map<number, symbol>, tabId: number) {
  const operation = Symbol("tab operation")
  operations.set(tabId, operation)
  return () => operations.get(tabId) === operation
}

async function getCurrentTab(tabId: number, isCurrent: () => boolean, expectedUrl?: string, documentId?: string) {
  const tab = await browser.tabs.get(tabId)
  if (!isCurrent() || !tab.url || (expectedUrl !== undefined && tab.url !== expectedUrl)) {
    return null
  }
  if (documentId !== undefined) {
    const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 })
    if (!isCurrent() || frame?.documentId !== documentId)
      return null
  }
  return tab
}

function notifyPageTranslationStateChanged(tabId: number, enabled: boolean, isCurrent: () => boolean) {
  if (!isCurrent())
    return
  void sendMessage("notifyTranslationStateChanged", { enabled }, tabId)
    .catch(error => logger.warn("Failed to notify page translation state change", error))
}

async function requestManagerToTogglePageTranslation(tabId: number, enabled: boolean, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) {
    throw new Error("Page translation request is no longer current")
  }
  // Only the top-frame manager can confirm the tab's page translation state.
  return sendMessage("askManagerToTogglePageTranslation", { enabled }, { tabId, frameId: 0 })
}

function isIframe(frameId: number | undefined): boolean {
  return frameId !== undefined && frameId !== 0
}

async function getDetectedCodeForTab(tabId: number): Promise<LangCodeISO6393> {
  const storedCode = await storage.getItem<unknown>(getDetectedCodeStateKey(tabId))
  return normalizeDetectedCode(storedCode)
}

function notifyDetectedCodeChanged(detectedCode: LangCodeISO6393) {
  void sendMessage("detectedPageLanguageChanged", { detectedCode })
    // The popup is often closed, so having no receiver is expected.
    .catch(() => {})
}

async function isActiveCurrentWindowTab(tabId: number, url: string, isCurrent: () => boolean): Promise<boolean> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  return isCurrent() && activeTab?.id === tabId && activeTab.url === url
}

function requestDetectedPageLanguageRefresh(tabId: number, isCurrent: () => boolean) {
  if (!isCurrent())
    return
  void sendMessage("refreshDetectedPageLanguage", undefined, tabId)
    .catch(error => logger.warn("Failed to refresh detected page language", error))
}

async function publishAndRefreshActiveTab(tabId: number, isCurrent: () => boolean): Promise<void> {
  const tab = await getCurrentTab(tabId, isCurrent)
  if (!tab?.url)
    return
  const detectedCode = await getDetectedCodeForTab(tabId)
  if (await isActiveCurrentWindowTab(tabId, tab.url, isCurrent)) {
    notifyDetectedCodeChanged(detectedCode)
    requestDetectedPageLanguageRefresh(tabId, isCurrent)
  }
}

export function translationMessage() {
  onMessage("getEnablePageTranslationByTabId", async (msg) => {
    const { tabId } = msg.data
    return await getTranslationState(tabId)
  })

  onMessage("getEnablePageTranslationFromContentScript", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      return await getTranslationState(tabId)
    }
    logger.error("Invalid tabId in getEnablePageTranslationFromContentScript", msg)
    return false
  })

  onMessage("injectCurrentIframesAfterTopFrameNodeTranslation", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const frameId = msg.sender?.frameId

    if (typeof tabId === "number" && frameId === 0) {
      await injectHostContentIntoCurrentTabIframesAfterNodeTranslation(tabId)
      return
    }

    logger.error("Invalid sender in injectCurrentIframesAfterTopFrameNodeTranslation", msg)
  })

  onMessage("reportDetectedPageLanguage", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const { detectedCodeOrUnd, url } = msg.data
    if (typeof tabId === "number" && msg.sender?.frameId === 0) {
      const isCurrent = beginTabOperation(languageOperations, tabId)
      if (!await getCurrentTab(tabId, isCurrent, url, msg.sender?.documentId))
        return
      const detectedCode = normalizeDetectedCode(detectedCodeOrUnd)
      await storage.setItem<LangCodeISO6393>(getDetectedCodeStateKey(tabId), detectedCode)

      if (await isActiveCurrentWindowTab(tabId, url, isCurrent)) {
        notifyDetectedCodeChanged(detectedCode)
      }
      return
    }

    logger.error("Invalid tabId in reportDetectedPageLanguage", msg)
  })

  onMessage("getDetectedCode", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      return await getDetectedCodeForTab(tabId)
    }

    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (typeof activeTab?.id === "number") {
      return await getDetectedCodeForTab(activeTab.id)
    }

    return DEFAULT_DETECTED_CODE
  })

  onMessage("tryToSetEnablePageTranslationByTabId", async (msg) => {
    const { tabId, enabled } = msg.data
    const isCurrent = beginTabOperation(pageStateOperations, tabId)
    const tab = await getCurrentTab(tabId, isCurrent)
    if (!tab?.url) {
      throw new Error("Page translation request is no longer current")
    }
    if (!enabled) {
      await setPageTranslationEnabled(tabId, false)
      if (!await getCurrentTab(tabId, isCurrent, tab.url)) {
        throw new Error("Page translation request is no longer current")
      }
      notifyPageTranslationStateChanged(tabId, false, isCurrent)
    }
    // The manager's report replaces this operation token as part of a normal
    // toggle. Its confirmed reply must not be rejected merely for that change.
    return requestManagerToTogglePageTranslation(tabId, enabled, isCurrent)
  })

  onMessage("setAndNotifyPageTranslationStateChangedByManager", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const { enabled, url } = msg.data
    if (typeof tabId === "number") {
      const senderFrameId = msg.sender?.frameId
      const sourceUrl = url ?? msg.sender?.url ?? msg.sender?.tab?.url
      if (!sourceUrl)
        return false

      if (enabled && isIframe(senderFrameId)) {
        // Iframe enabled echoes only synchronize UI; they must not write
        // tab-level state because that state is scoped to the top-frame origin.
        const stateOperation = pageStateOperations.get(tabId)
        const isCurrent = () => pageStateOperations.get(tabId) === stateOperation
        const tab = await getCurrentTab(tabId, isCurrent)
        if (!tab?.url)
          return false
        const currentState = await getPageTranslationState(tabId)
        const frame = await browser.webNavigation.getFrame({ tabId, frameId: senderFrameId! })
        if (!isCurrent() || !frame || frame.url !== sourceUrl
          || (msg.sender?.documentId && frame.documentId !== msg.sender.documentId)
          || !isPageTranslationStateInUrlScope(currentState, tab.url)) {
          return false
        }
        if (!await getCurrentTab(tabId, isCurrent, tab.url))
          return false

        notifyPageTranslationStateChanged(tabId, true, isCurrent)
        return true
      }

      if (isIframe(senderFrameId))
        return false
      const isCurrent = beginTabOperation(pageStateOperations, tabId)
      if (!await getCurrentTab(tabId, isCurrent, sourceUrl, msg.sender?.documentId))
        return false
      await setPageTranslationEnabled(tabId, enabled, sourceUrl)
      if (!await getCurrentTab(tabId, isCurrent, sourceUrl, msg.sender?.documentId))
        return false
      notifyPageTranslationStateChanged(tabId, enabled, isCurrent)

      if (enabled && !isIframe(senderFrameId)) {
        void injectHostContentIntoTabIframes(tabId)
      }
      return true
    }
    else {
      logger.error("tabId is not a number", msg)
      return false
    }
  })

  // === Helper Functions ===
  async function getTranslationState(tabId: number): Promise<boolean> {
    const state = await getPageTranslationState(tabId)
    // A content bootstrap can run before onCommitted finishes clearing the old
    // state. Validate against the live top-tab URL, including iframe callers.
    const tab = await browser.tabs.get(tabId)
    return isPageTranslationStateInUrlScope(state, tab.url)
  }

  // === Cleanup ===
  browser.tabs.onRemoved.addListener(async (tabId) => {
    pageStateOperations.delete(tabId)
    languageOperations.delete(tabId)
    try {
      await Promise.all([
        storage.removeItem(getTranslationStateKey(tabId)),
        storage.removeItem(getDetectedCodeStateKey(tabId)),
      ])
    }
    catch (error) {
      logger.error("Failed to clear closed-tab translation state:", error)
    }
  })

  browser.tabs.onActivated.addListener(async (activeInfo) => {
    const isCurrent = beginTabOperation(languageOperations, activeInfo.tabId)
    try {
      await publishAndRefreshActiveTab(activeInfo.tabId, isCurrent)
    }
    catch (error) {
      logger.error("Failed to refresh active-tab language:", error)
    }
  })

  // Clear translation state only when the tab leaves the origin where it was enabled.
  browser.webNavigation.onCommitted.addListener(async (details) => {
    // Only handle main frame navigations, not iframes
    if (details.frameId !== 0)
      return

    // A reload can replace the document without changing its URL.
    languageOperations.delete(details.tabId)
    const isCurrent = beginTabOperation(pageStateOperations, details.tabId)
    try {
      const state = await getPageTranslationState(details.tabId)
      if (!isCurrent() || !state?.enabled)
        return
      const tab = await getCurrentTab(details.tabId, isCurrent, details.url, details.documentId)
      if (!tab?.url || isPageTranslationStateInUrlScope(state, tab.url))
        return
      await storage.removeItem(getTranslationStateKey(details.tabId))
    }
    catch (error) {
      logger.error("Failed to clear navigated page translation state:", error)
    }
  })
}
