import type { Config } from "@/types/config/config"
import type { APIProviderConfig, LLMProviderConfig, ProviderConfig, ProvidersConfig } from "@/types/config/provider"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import { isAPIProviderConfig, isLLMProviderConfig } from "@/types/config/provider"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"

export function getProviderConfigById<T extends ProviderConfig>(providersConfig: T[], providerId: string): T | undefined {
  return providersConfig.find(p => p.id === providerId)
}

export function getLLMProvidersConfig(providersConfig: ProvidersConfig): LLMProviderConfig[] {
  return providersConfig.filter(isLLMProviderConfig)
}

export function getAPIProvidersConfig(providersConfig: ProvidersConfig): APIProviderConfig[] {
  return providersConfig.filter(isAPIProviderConfig)
}

export function filterEnabledProvidersConfig(providersConfig: ProvidersConfig): ProvidersConfig {
  return providersConfig.filter(p => p.enabled)
}

/**
 * Compute fallback provider assignments when a provider is deleted.
 * For each feature using the deleted provider, picks the first compatible remaining provider.
 */
export function computeProviderFallbacksAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): Partial<Record<FeatureKey, string>> {
  const updates: Partial<Record<FeatureKey, string>> = {}
  for (const key of FEATURE_KEYS) {
    const def = FEATURE_PROVIDER_DEFS[key]
    const currentId = def.getProviderId(config)
    if (currentId !== deletedProviderId)
      continue
    const candidates = remainingProviders.filter(p => p.enabled && def.isProvider(p.provider))
    if (candidates.length > 0)
      updates[key] = candidates[0].id
  }
  return updates
}

export function findFeatureMissingProvider(
  remainingProviders: ProvidersConfig,
): FeatureKey | null {
  for (const key of FEATURE_KEYS) {
    const def = FEATURE_PROVIDER_DEFS[key]
    if (!remainingProviders.some(p => p.enabled && def.isProvider(p.provider)))
      return key
  }
  return null
}
