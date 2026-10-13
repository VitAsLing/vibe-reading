import { browser } from "#imports"
import { logger } from "@/utils/logger"
import { matchDomainPattern } from "@/utils/url"
import { getPageTranslationEnabled } from "./page-translation-state"

const HOST_CONTENT_SCRIPT_FILE = "/content-scripts/host.js" as const
const IFRAME_FULL_RUNTIME_AUTO_INJECT_PATTERNS = ["browse.library.kiwix.org"] as const

const pendingDocumentKeys = new Set<string>()
const injectedDocumentKeysByFrame = new Map<string, string>()
const fullRuntimeAutoInjectUrlByTab = new Map<number, string>()

interface FrameInjectionDetails {
  tabId: number
  frameId: number
  documentId?: string
  url?: string
}

interface InjectHostContentIntoTabIframesOptions {
  requirePageTranslationEnabled?: boolean
}

interface FrameInfo {
  frameId: number
  documentId?: string
  url?: string
}

function getDocumentInjectionKey(details: FrameInjectionDetails) {
  // documentId is best, but getAllFrames may not expose it. Fall back to URL so
  // explicit per-tab injections still dedupe until the frame navigates.
  return `${details.tabId}:${details.frameId}:${details.documentId ?? details.url ?? "unknown"}`
}

function getFrameInjectionKey(details: { tabId: number, frameId: number }) {
  return `${details.tabId}:${details.frameId}`
}

function clearTabDocumentState(tabId: number) {
  for (const key of pendingDocumentKeys) {
    if (key.startsWith(`${tabId}:`)) {
      pendingDocumentKeys.delete(key)
    }
  }

  for (const key of injectedDocumentKeysByFrame.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      injectedDocumentKeysByFrame.delete(key)
    }
  }

  fullRuntimeAutoInjectUrlByTab.delete(tabId)
}

function clearFrameInjectedDocumentState(tabId: number, frameId: number) {
  injectedDocumentKeysByFrame.delete(getFrameInjectionKey({ tabId, frameId }))
}

function pruneInjectedFrames(tabId: number, liveFrameIds: Set<number>) {
  for (const frameKey of injectedDocumentKeysByFrame.keys()) {
    if (!frameKey.startsWith(`${tabId}:`)) {
      continue
    }

    const frameId = Number(frameKey.split(":")[1])
    if (!liveFrameIds.has(frameId)) {
      injectedDocumentKeysByFrame.delete(frameKey)
    }
  }
}

function getInjectionTarget(details: FrameInjectionDetails) {
  if (details.documentId) {
    return { tabId: details.tabId, documentIds: [details.documentId] }
  }

  return { tabId: details.tabId, frameIds: [details.frameId] }
}

async function getFrameSnapshot(tabId: number): Promise<FrameInfo[]> {
  return await browser.webNavigation.getAllFrames({ tabId }) ?? []
}

function isFullRuntimeAutoInjectUrl(url: string | undefined): url is string {
  if (!url)
    return false

  return IFRAME_FULL_RUNTIME_AUTO_INJECT_PATTERNS.some(pattern => matchDomainPattern(url, pattern))
}

async function getShouldInjectHostContentIntoTabIframes(
  tabId: number,
  options: InjectHostContentIntoTabIframesOptions = {},
): Promise<boolean> {
  const requirePageTranslationEnabled = options.requirePageTranslationEnabled ?? true
  return requirePageTranslationEnabled ? await getPageTranslationEnabled(tabId) : true
}

async function injectHostContentIntoFrame(
  details: FrameInjectionDetails,
  frames?: FrameInfo[],
) {
  const documentKey = getDocumentInjectionKey(details)
  const frameKey = getFrameInjectionKey(details)
  if (pendingDocumentKeys.has(documentKey)
    || injectedDocumentKeysByFrame.get(frameKey) === documentKey) {
    return
  }

  pendingDocumentKeys.add(documentKey)

  try {
    try {
      const frameSnapshot = frames === undefined ? await getFrameSnapshot(details.tabId) : frames
      const liveFrameIds = new Set(frameSnapshot.map(frame => frame.frameId))
      liveFrameIds.add(details.frameId)
      pruneInjectedFrames(details.tabId, liveFrameIds)
    }
    catch (error) {
      logger.error("[Background][IframeInjection] Failed to resolve iframe injection prerequisites", error)
      return
    }

    try {
      const target = getInjectionTarget(details) as Parameters<typeof browser.scripting.executeScript>[0]["target"]

      await browser.scripting.executeScript({
        target,
        files: [HOST_CONTENT_SCRIPT_FILE],
      })
      injectedDocumentKeysByFrame.set(frameKey, documentKey)
    }
    catch (error) {
      logger.warn("[Background][IframeInjection] Failed to inject iframe content scripts", error)
    }
  }
  finally {
    pendingDocumentKeys.delete(documentKey)
  }
}

export async function injectHostContentIntoTabIframes(
  tabId: number,
  options: InjectHostContentIntoTabIframesOptions = {},
) {
  let shouldInject: boolean
  try {
    shouldInject = await getShouldInjectHostContentIntoTabIframes(tabId, options)
  }
  catch (error) {
    logger.warn("[Background][IframeInjection] Failed to resolve iframe injection state", error)
    return
  }

  if (!shouldInject)
    return

  let frames: FrameInfo[]
  try {
    frames = await getFrameSnapshot(tabId)
  }
  catch (error) {
    logger.error("[Background][IframeInjection] Failed to resolve tab iframe injection prerequisites", error)
    return
  }

  const liveFrameIds = new Set(frames.map(frame => frame.frameId))
  pruneInjectedFrames(tabId, liveFrameIds)

  await Promise.all(frames
    .filter(frame => frame.frameId !== 0)
    .map(frame => injectHostContentIntoFrame({
      tabId,
      frameId: frame.frameId,
      documentId: frame.documentId,
      url: frame.url,
    }, frames)))
}

export async function injectHostContentIntoCurrentTabIframesAfterNodeTranslation(tabId: number) {
  await injectHostContentIntoTabIframes(tabId, { requirePageTranslationEnabled: false })
}

export function setupIframeInjection() {
  browser.tabs.onRemoved.addListener(clearTabDocumentState)
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) {
      clearTabDocumentState(details.tabId)
      if (isFullRuntimeAutoInjectUrl(details.url)) {
        fullRuntimeAutoInjectUrlByTab.set(details.tabId, details.url)
      }
      return
    }

    clearFrameInjectedDocumentState(details.tabId, details.frameId)
  })

  // Only page translation eagerly injects host content into newly completed
  // subframes. Top-frame node translation can separately scan existing iframes
  // once, but it does not enable late iframe injection.
  browser.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId === 0) {
      if (!isFullRuntimeAutoInjectUrl(details.url)) {
        fullRuntimeAutoInjectUrlByTab.delete(details.tabId)
        return
      }

      fullRuntimeAutoInjectUrlByTab.set(details.tabId, details.url)
      await injectHostContentIntoTabIframes(details.tabId, { requirePageTranslationEnabled: false })
      return
    }

    const fullRuntimeAutoInjectUrl = fullRuntimeAutoInjectUrlByTab.get(details.tabId)
      ?? (isFullRuntimeAutoInjectUrl(details.url) ? details.url : undefined)
    if (fullRuntimeAutoInjectUrl) {
      await injectHostContentIntoFrame(details)
      return
    }

    let shouldInject: boolean
    try {
      shouldInject = await getShouldInjectHostContentIntoTabIframes(details.tabId)
      if (!shouldInject)
        return
    }
    catch (error) {
      logger.warn("[Background][IframeInjection] Failed to resolve iframe injection state", error)
      return
    }

    await injectHostContentIntoFrame(details)
  })
}
