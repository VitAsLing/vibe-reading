import type {
  APIProviderConfig,
  CustomLLMProviderConfig,
  LLMProviderConfig,
  ProviderConfig,
} from "./schemas"
import {
  isAPIProvider,
  isCustomLLMProvider,
  isLLMProvider,
} from "./constants"

export * from "./constants"
export * from "./schemas"

export function isLLMProviderConfig(config: ProviderConfig): config is LLMProviderConfig {
  return isLLMProvider(config.provider)
}

export function isCustomLLMProviderConfig(config: ProviderConfig): config is CustomLLMProviderConfig {
  return isCustomLLMProvider(config.provider)
}

export function isAPIProviderConfig(config: ProviderConfig): config is APIProviderConfig {
  return isAPIProvider(config.provider)
}
