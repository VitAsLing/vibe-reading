import type { LangCodeISO6393 } from "@/definitions"
import type {
  BackgroundGenerateTextPayload,
  BackgroundGenerateTextResponse,
} from "@/types/background-generate-text"
import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { BatchQueueConfig, RequestQueueConfig } from "@/types/config/translate"
import type { ProxyRequest, ProxyResponse } from "@/types/proxy-fetch"
import { defineExtensionMessaging } from "@webext-core/messaging"

interface ProtocolMap {
  // navigation
  openOptionsPage: (data?: { route?: `/${string}` }) => void
  saveConfiguration: (data: {
    patch: Partial<Config>
    collectionBase: {
      providersConfig?: Config["providersConfig"]
      customPromptsConfig?: Config["translate"]["customPromptsConfig"]
    }
  }) => Promise<Config>
  // translation state
  getEnablePageTranslationByTabId: (data: { tabId: number }) => boolean | undefined
  getEnablePageTranslationFromContentScript: () => Promise<boolean>
  tryToSetEnablePageTranslationByTabId: (data: { tabId: number, enabled: boolean }) => boolean
  setAndNotifyPageTranslationStateChangedByManager: (data: { enabled: boolean, url?: string }) => boolean
  notifyTranslationStateChanged: (data: { enabled: boolean }) => void
  injectCurrentIframesAfterTopFrameNodeTranslation: () => void
  reportDetectedPageLanguage: (data: { detectedCodeOrUnd: LangCodeISO6393 | "und", url: string }) => void
  refreshDetectedPageLanguage: () => void
  getDetectedCode: () => LangCodeISO6393
  detectedPageLanguageChanged: (data: { detectedCode: LangCodeISO6393 }) => void
  // ask host to start page translation
  askManagerToTogglePageTranslation: (data: { enabled: boolean }) => boolean
  // request
  enqueueTranslateRequest: (data: { text: string, langConfig: Config["language"], providerConfig: ProviderConfig, customPromptsConfig?: Config["translate"]["customPromptsConfig"], scheduleAt: number, hash: string, webTitle?: string | null, webDescription?: string | null, webContent?: string | null, webSummary?: string | null }) => Promise<string>
  getOrGenerateWebPageSummary: (data: { webTitle: string, webContent: string, providerConfig: ProviderConfig }) => Promise<string | null>
  backgroundGenerateText: (data: BackgroundGenerateTextPayload) => Promise<BackgroundGenerateTextResponse>
  setTranslateRequestQueueConfig: (data: Partial<RequestQueueConfig>) => void
  setTranslateBatchQueueConfig: (data: Partial<BatchQueueConfig>) => void
  // network proxy
  backgroundFetch: (data: ProxyRequest) => Promise<ProxyResponse>
  // cache management
  clearAllTranslationRelatedCache: () => Promise<void>
}

export const { sendMessage, onMessage }
  = defineExtensionMessaging<ProtocolMap>()
