import type { WebPageContext } from "@/types/content"
import { getDocumentDescription } from "@/utils/content/metadata"
import { logger } from "@/utils/logger"
import { truncateWebPageContent } from "./webpage-content"

export interface CachedWebPageContext extends WebPageContext {
  url: string
  webContent: string
}

let cachedWebPageContext: CachedWebPageContext | null = null

function createDefuddleSnapshotDocument() {
  const clonedDoc = document.implementation.createHTMLDocument(document.title)
  clonedDoc.documentElement.innerHTML = document.documentElement.outerHTML
  return clonedDoc
}

async function extractWebpageContent(checkpoint?: () => void): Promise<string> {
  try {
    const { default: Defuddle, createMarkdownContent } = await import("defuddle/full")
    checkpoint?.()
    const snapshotDoc = createDefuddleSnapshotDocument()
    const result = new Defuddle(snapshotDoc, {
      separateMarkdown: true,
      url: window.location.href,
      useAsync: false,
    }).parse()

    if (result.contentMarkdown)
      return result.contentMarkdown
    if (result.content)
      return createMarkdownContent(result.content, window.location.href)
  }
  catch (error) {
    // Cancellation is an operation boundary, not a parser failure or a reason
    // to fill the old request with the new page's body text.
    checkpoint?.()
    logger.warn("Defuddle parsing failed, falling back to body text:", error)
  }
  return document.body?.textContent || ""
}

export async function getOrCreateWebPageContext(checkpoint?: () => void): Promise<CachedWebPageContext | null> {
  checkpoint?.()
  if (typeof window === "undefined" || typeof document === "undefined")
    return null

  const currentUrl = window.location.href
  if (cachedWebPageContext?.url === currentUrl) {
    return cachedWebPageContext
  }

  const webContent = await extractWebpageContent(checkpoint)
  checkpoint?.()
  if (window.location.href !== currentUrl)
    return null
  cachedWebPageContext = {
    url: currentUrl,
    webTitle: document.title || "",
    webDescription: getDocumentDescription(document),
    webContent: truncateWebPageContent(webContent),
  }
  return cachedWebPageContext
}
