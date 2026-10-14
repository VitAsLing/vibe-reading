import type { Config } from "@/types/config/config"
import type { LLMProviderConfig } from "@/types/config/provider"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { storage } from "#imports"
import { isCustomLLMProvider } from "@/types/config/provider"
import { getLLMProvidersConfig, getProviderConfigById } from "../config/helpers"
import { CONFIG_STORAGE_KEY } from "../constants/config"
import { RETIRED_PROVIDER_MODELS } from "../constants/models"
import { attachRequestErrorMeta } from "../request/retry-policy"
import { getProviderHeaders } from "./headers"
import { resolveModelId } from "./model-id"

const CREATE_AI_MAPPER = {
  "openai-compatible": createOpenAICompatible,
  "openai": createOpenAI,
  "deepseek": createDeepSeek,
} as const

export async function getModelById(providerId: string) {
  const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
  if (!config) {
    throw new Error("Config not found")
  }

  const LLMProvidersConfig = getLLMProvidersConfig(config.providersConfig)
  const providerConfig = getProviderConfigById(LLMProvidersConfig, providerId)
  if (!providerConfig) {
    throw new Error(`Provider ${providerId} not found`)
  }

  return getModelFromProviderConfig(providerConfig)
}

export function getModelFromProviderConfig(providerConfig: LLMProviderConfig) {
  const modelId = resolveModelId(providerConfig.model)
  if (!modelId) {
    throw new Error("Model is undefined")
  }

  if (providerConfig.provider !== "openai-compatible") {
    const retiredModels: Record<string, { shutdownDate: string, replacement: string }> = RETIRED_PROVIDER_MODELS[providerConfig.provider]
    const retired = retiredModels[modelId]
    const baseURL = providerConfig.baseURL?.trim()
    const officialOrigin = providerConfig.provider === "openai"
      ? /^https:\/\/api\.openai\.com(?::443)?(?:\/|$)/i
      : /^https:\/\/api\.deepseek\.com(?::443)?(?:\/|$)/i
    if (retired && (!baseURL || officialOrigin.test(baseURL))) {
      throw attachRequestErrorMeta(new Error(`${modelId} was retired from the ${providerConfig.provider} API on ${retired.shutdownDate}. Select a supported model explicitly, such as ${retired.replacement}.`), {
        kind: "bad-request",
        isRetryable: false,
      })
    }
  }

  const headers = getProviderHeaders(providerConfig.headers)
  const provider = isCustomLLMProvider(providerConfig.provider)
    ? CREATE_AI_MAPPER[providerConfig.provider]({
        name: providerConfig.provider,
        baseURL: providerConfig.baseURL ?? "",
        supportsStructuredOutputs: true,
        ...(providerConfig.apiKey && { apiKey: providerConfig.apiKey }),
        ...(headers && { headers }),
      })
    : CREATE_AI_MAPPER[providerConfig.provider]({
        ...(providerConfig.baseURL && { baseURL: providerConfig.baseURL }),
        ...(providerConfig.apiKey && { apiKey: providerConfig.apiKey }),
        ...(headers && { headers }),
      })

  return provider.languageModel(modelId)
}
