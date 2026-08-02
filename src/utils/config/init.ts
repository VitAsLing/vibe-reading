import type { Config } from "@/types/config/config"
import type { ConfigMeta } from "@/types/config/meta"
import { dequal } from "dequal"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { isAPIProviderConfig } from "@/types/config/provider"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import { logger } from "../logger"

const DEPRECATED_DEEPSEEK_MODELS = {
  "deepseek-chat": "disabled",
  "deepseek-reasoner": "enabled",
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function migrateDeprecatedDeepSeekModels(config: unknown): { config: unknown, changed: boolean } {
  if (!isRecord(config) || !Array.isArray(config.providersConfig)) {
    return { config, changed: false }
  }

  let changed = false
  const providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isRecord(providerConfig) || providerConfig.provider !== "deepseek" || !isRecord(providerConfig.model)) {
      return providerConfig
    }

    const legacyModel = providerConfig.model.model
    if (legacyModel !== "deepseek-chat" && legacyModel !== "deepseek-reasoner") {
      return providerConfig
    }

    changed = true
    let providerOptions = providerConfig.providerOptions

    if (providerConfig.model.isCustomModel === false && (providerOptions === undefined || isRecord(providerOptions))) {
      const thinking = isRecord(providerOptions) && isRecord(providerOptions.thinking)
        ? providerOptions.thinking
        : undefined

      if (!thinking || !("type" in thinking)) {
        providerOptions = {
          ...(isRecord(providerOptions) ? providerOptions : {}),
          thinking: {
            ...thinking,
            type: DEPRECATED_DEEPSEEK_MODELS[legacyModel],
          },
        }
      }
    }

    return {
      ...providerConfig,
      model: {
        ...providerConfig.model,
        model: "deepseek-v4-flash",
      },
      ...(providerOptions !== providerConfig.providerOptions && { providerOptions }),
    }
  })

  if (!changed) {
    return { config, changed: false }
  }

  return {
    config: {
      ...config,
      providersConfig,
    },
    changed: true,
  }
}

/**
 * Initialize the config, this function should only be called once in the background script
 * @returns The extension config
 */
export async function initializeConfig() {
  const [storedConfig, configMeta] = await Promise.all([
    storage.getItem<unknown>(`local:${CONFIG_STORAGE_KEY}`),
    storage.getMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`),
  ])

  let configCandidate: unknown
  let didConfigChange: boolean

  if (!storedConfig) {
    configCandidate = DEFAULT_CONFIG
    didConfigChange = true
  }
  else {
    const migration = migrateDeprecatedDeepSeekModels(storedConfig)
    configCandidate = migration.config
    didConfigChange = migration.changed
  }

  let config: Config
  const parseResult = configSchema.safeParse(configCandidate)
  if (!parseResult.success) {
    logger.warn("Config is invalid, using default config")
    config = DEFAULT_CONFIG
    didConfigChange = true
  }
  else if (!dequal(configCandidate, parseResult.data)) {
    config = parseResult.data
    didConfigChange = true
  }
  else {
    config = parseResult.data
  }

  if (import.meta.env.DEV) {
    const apiKeyResult = applyAPIKeysFromEnv(config)
    config = apiKeyResult.config
    didConfigChange = didConfigChange || apiKeyResult.changed
  }

  const didMetaNeedUpdate
    = configMeta?.schemaVersion !== CONFIG_SCHEMA_VERSION
      || configMeta?.lastModifiedAt === undefined

  if (didConfigChange) {
    await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, config)
  }

  if (didConfigChange || didMetaNeedUpdate) {
    await storage.setMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`, {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: configMeta?.lastModifiedAt ?? Date.now(),
    })
  }
}

function applyAPIKeysFromEnv(config: Config): { config: Config, changed: boolean } {
  let changed = false

  const providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const apiKeyEnvName = `WXT_${providerConfig.provider.toUpperCase()}_API_KEY`
    const envApiKey = import.meta.env[apiKeyEnvName] as string | undefined
    if (!envApiKey || providerConfig.apiKey === envApiKey) {
      return providerConfig
    }

    changed = true
    return {
      ...providerConfig,
      apiKey: envApiKey,
    }
  })

  if (!changed) {
    return { config, changed: false }
  }

  return {
    config: {
      ...config,
      providersConfig,
    },
    changed: true,
  }
}
