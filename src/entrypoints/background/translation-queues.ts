import type { ApplyTranslationQueueConfig } from "./config"
import type { Config } from "@/types/config/config"
import type { LLMProviderConfig, ProviderConfig } from "@/types/config/provider"
import type { BatchQueueConfig, RequestQueueConfig } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { PromptResolver } from "@/utils/host/translate/api/ai"
import type { TranslatePromptOptions } from "@/utils/prompts/translate"
import { isLLMProviderConfig } from "@/types/config/provider"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, BATCH_SEPARATOR_LINE_PATTERN } from "@/utils/constants/prompt"
import { generateArticleSummary } from "@/utils/content/summary"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { getTranslatePrompt, getTranslatePromptFromConfig } from "@/utils/prompts/translate"
import { BatchQueue } from "@/utils/request/batch-queue"
import { RequestQueue } from "@/utils/request/request-queue"
import { ensureInitializedConfig } from "./config"

export function parseBatchResult(result: string): string[] {
  return result.trim().split(BATCH_SEPARATOR_LINE_PATTERN).map(t => t.trim())
}

export function shouldUseBatchQueue(providerConfig: ProviderConfig): boolean {
  return isLLMProviderConfig(providerConfig)
}

function getSnapshotPromptResolver<TContext>(
  customPromptsConfig: Config["translate"]["customPromptsConfig"] | undefined,
  fallback: PromptResolver<TContext>,
): PromptResolver<TContext> {
  if (customPromptsConfig === undefined)
    return fallback
  return async (targetLang, input, options) => getTranslatePromptFromConfig(
    { customPromptsConfig }, targetLang, input,
    options as TranslatePromptOptions<WebPagePromptContext>,
  )
}

export async function executeBatchTranslation<TContext>(
  dataList: TranslateBatchData<TContext>[],
  promptResolver: PromptResolver<TContext>,
): Promise<string[]> {
  const { langConfig, providerConfig, context, customPromptsConfig } = dataList[0]
  const texts = dataList.map(d => d.text)

  const batchText = texts.join(`\n\n${BATCH_SEPARATOR}\n\n`)
  const result = await executeTranslate(batchText, langConfig, providerConfig,
    getSnapshotPromptResolver(customPromptsConfig, promptResolver), { isBatch: true, context })
  return parseBatchResult(result)
}

async function getOrGenerateWebPageSummary(
  webTitle: string,
  webContent: string,
  providerConfig: LLMProviderConfig,
  requestQueue: RequestQueue,
): Promise<string | null> {
  const preparedText = cleanText(webContent)
  if (!preparedText) {
    return null
  }

  const textHash = Sha256Hex(preparedText)
  const cacheKey = Sha256Hex(webTitle, textHash, JSON.stringify(providerConfig))

  const cached = await db.articleSummaryCache.get(cacheKey)
  if (cached) {
    logger.info("Using cached summary")
    return cached.summary
  }

  const thunk = async () => {
    const cachedAgain = await db.articleSummaryCache.get(cacheKey)
    if (cachedAgain) {
      return cachedAgain.summary
    }

    const summary = await generateArticleSummary(webTitle, webContent, providerConfig)
    if (!summary) {
      return ""
    }

    await db.articleSummaryCache.put({
      key: cacheKey,
      summary,
      createdAt: new Date(),
    })

    logger.info("Generated and cached new summary")
    return summary
  }

  try {
    const summary = await requestQueue.enqueue(thunk, Date.now(), cacheKey)
    return summary || null
  }
  catch (error) {
    logger.warn("Failed to get/generate summary:", error)
    return null
  }
}

export interface TranslateBatchData<TContext = unknown> {
  text: string
  langConfig: Config["language"]
  providerConfig: ProviderConfig
  hash: string
  scheduleAt: number
  context?: TContext
  customPromptsConfig?: Config["translate"]["customPromptsConfig"]
}

interface TranslationQueueSetupConfig<TContext = unknown> {
  requestQueueConfig: RequestQueueConfig
  batchQueueConfig: BatchQueueConfig
  promptResolver: PromptResolver<TContext>
}

function createTranslationQueues<TContext>(config: TranslationQueueSetupConfig<TContext>) {
  const { rate, capacity } = config.requestQueueConfig
  const { maxCharactersPerBatch, maxItemsPerBatch } = config.batchQueueConfig
  const { promptResolver } = config

  const requestQueue = new RequestQueue({
    rate,
    capacity,
    timeoutMs: 20_000,
    maxRetries: 2,
    baseRetryDelayMs: 1_000,
  })

  const batchQueue = new BatchQueue<TranslateBatchData<TContext>, string>({
    maxCharactersPerBatch,
    maxItemsPerBatch,
    batchDelay: 100,
    maxRetries: 3,
    enableFallbackToIndividual: true,
    getBatchKey: (data) => {
      return Sha256Hex(
        JSON.stringify(data.langConfig), JSON.stringify(data.providerConfig),
        JSON.stringify(data.customPromptsConfig ?? null), JSON.stringify(data.context ?? null),
      )
    },
    getCharacters: data => data.text.length,
    executeBatch: async (dataList) => {
      const hash = Sha256Hex(...dataList.map(d => d.hash))
      const earliestScheduleAt = Math.min(...dataList.map(d => d.scheduleAt))

      const batchThunk = async (): Promise<string[]> => {
        return await executeBatchTranslation(dataList, promptResolver)
      }

      return requestQueue.enqueue(batchThunk, earliestScheduleAt, hash)
    },
    executeIndividual: async (data) => {
      const { text, langConfig, providerConfig, hash, scheduleAt, context, customPromptsConfig } = data
      const thunk = async () => {
        return executeTranslate(text, langConfig, providerConfig,
          getSnapshotPromptResolver(customPromptsConfig, promptResolver), { context })
      }
      return requestQueue.enqueue(thunk, scheduleAt, hash)
    },
    onError: (error, context) => {
      const errorType = context.isFallback ? "Individual request" : "Batch request"
      logger.error(
        `${errorType} failed (batchKey: ${context.batchKey}, retry: ${context.retryCount}):`,
        error.message,
      )
    },
  })

  return { requestQueue, batchQueue }
}

export function setUpWebPageTranslationQueue() {
  const initializeQueues = async () => {
    const config = await ensureInitializedConfig()
    const { translate: { requestQueueConfig, batchQueueConfig } } = config ?? DEFAULT_CONFIG
    return createTranslationQueues({
      requestQueueConfig,
      batchQueueConfig,
      promptResolver: getTranslatePrompt,
    })
  }
  let queuesPromise: ReturnType<typeof initializeQueues> | undefined = initializeQueues()

  const getQueues = async () => {
    const attempt = queuesPromise ??= initializeQueues()
    try {
      return await attempt
    }
    catch (error) {
      // Fail this cohort unchanged; only a later explicit request starts again.
      if (queuesPromise === attempt)
        queuesPromise = undefined
      throw error
    }
  }

  // Startup has no caller to receive failures; handlers still await the original promise.
  void queuesPromise.catch(error => logger.error("Failed to initialize translation queues:", error))

  onMessage("enqueueTranslateRequest", async (message) => {
    const { requestQueue, batchQueue } = await getQueues()
    const { data: { text, langConfig, providerConfig, scheduleAt, hash, webTitle, webDescription, webContent, webSummary, customPromptsConfig } } = message

    // Check cache first
    if (hash) {
      const cached = await db.translationCache.get(hash)
      if (cached) {
        return cached.translation
      }
    }

    let result = ""
    const context: WebPagePromptContext = {
      webTitle: normalizePromptContextValue(webTitle),
      webDescription: normalizePromptContextValue(webDescription),
      webContent: normalizePromptContextValue(webContent),
      webSummary: normalizePromptContextValue(webSummary),
    }

    if (shouldUseBatchQueue(providerConfig)) {
      const data = { text, langConfig, providerConfig, hash, scheduleAt, context, customPromptsConfig }
      result = await batchQueue.enqueue(data)
    }
    else {
      // Create thunk based on type and params
      const thunk = () => executeTranslate(text, langConfig, providerConfig,
        getSnapshotPromptResolver(customPromptsConfig, getTranslatePrompt))
      result = await requestQueue.enqueue(thunk, scheduleAt, hash)
    }

    // Cache the translation result if successful
    if (result && hash) {
      await db.translationCache.put({
        key: hash,
        translation: result,
        createdAt: new Date(),
      })
    }

    return result
  })

  onMessage("getOrGenerateWebPageSummary", async (message) => {
    const { requestQueue } = await getQueues()
    const { webTitle, webContent, providerConfig } = message.data

    if (!isLLMProviderConfig(providerConfig) || !webTitle || !webContent) {
      return null
    }

    return await getOrGenerateWebPageSummary(webTitle, webContent, providerConfig, requestQueue)
  })

  onMessage("setTranslateRequestQueueConfig", async (message) => {
    const { requestQueue } = await getQueues()
    const { data } = message
    requestQueue.setQueueOptions(data)
  })

  onMessage("setTranslateBatchQueueConfig", async (message) => {
    const { batchQueue } = await getQueues()
    const { data } = message
    batchQueue.setBatchConfig(data)
  })

  return async (): Promise<ApplyTranslationQueueConfig> => {
    const { requestQueue, batchQueue } = await getQueues()
    return ({ requestQueueConfig, batchQueueConfig }) => {
      if (requestQueueConfig)
        requestQueue.setQueueOptions(requestQueueConfig)
      if (batchQueueConfig)
        batchQueue.setBatchConfig(batchQueueConfig)
    }
  }
}
