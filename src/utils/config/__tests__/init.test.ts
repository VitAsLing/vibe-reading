import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isAPIProviderConfig } from "@/types/config/provider"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"

const getItemMock = vi.fn()
const getMetaMock = vi.fn()
const setItemMock = vi.fn()
const setMetaMock = vi.fn()
const loggerWarnMock = vi.fn()

vi.mock("#imports", () => ({
  storage: {
    getItem: getItemMock,
    getMeta: getMetaMock,
    setItem: setItemMock,
    setMeta: setMetaMock,
  },
}))

vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: getItemMock,
    getMeta: getMetaMock,
    setItem: setItemMock,
    setMeta: setMetaMock,
  },
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    warn: loggerWarnMock,
  },
}))

function buildStableConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const apiKeyEnvName = `WXT_${providerConfig.provider.toUpperCase()}_API_KEY`
    const envApiKey = import.meta.env[apiKeyEnvName] as string | undefined
    if (!envApiKey) {
      return providerConfig
    }

    return {
      ...providerConfig,
      apiKey: envApiKey,
    }
  })
  return config
}

interface MutableStoredProvider {
  provider?: unknown
  model?: {
    model?: unknown
    isCustomModel?: unknown
    customModel?: unknown
  }
  providerOptions?: unknown
}

interface MutableStoredConfig extends Record<string, unknown> {
  providersConfig: MutableStoredProvider[]
}

function buildLegacyDeepSeekConfig(
  legacyModel: "deepseek-chat" | "deepseek-reasoner",
  providerOptions?: Record<string, unknown>,
  isCustomModel = false,
): unknown {
  const config = structuredClone(buildStableConfig()) as unknown as MutableStoredConfig
  const deepseekProvider = config.providersConfig.find(provider => provider.provider === "deepseek")
  if (!deepseekProvider?.model) {
    throw new Error("DeepSeek provider not found")
  }

  deepseekProvider.model.model = legacyModel
  deepseekProvider.model.isCustomModel = isCustomModel
  deepseekProvider.model.customModel = isCustomModel ? "custom-deepseek-model" : null

  if (providerOptions === undefined) {
    delete deepseekProvider.providerOptions
  }
  else {
    deepseekProvider.providerOptions = providerOptions
  }

  return config
}

function getDeepSeekProvider(config: Config) {
  const provider = config.providersConfig.find(providerConfig => providerConfig.provider === "deepseek")
  if (!provider) {
    throw new Error("DeepSeek provider not found")
  }
  return provider
}

describe("initializeConfig", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setItemMock.mockResolvedValue(undefined)
    setMetaMock.mockResolvedValue(undefined)
  })

  it("does not write when config and meta are already up to date", async () => {
    const config = buildStableConfig()
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 123,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).not.toHaveBeenCalled()
    expect(setMetaMock).not.toHaveBeenCalled()
  })

  it("writes config and meta when config is missing", async () => {
    getItemMock.mockResolvedValueOnce(null)
    getMetaMock.mockResolvedValueOnce(null)

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).toHaveBeenCalledTimes(1)
    expect(setItemMock).toHaveBeenCalledWith("local:config", expect.any(Object))
    expect(setMetaMock).toHaveBeenCalledTimes(1)
    expect(setMetaMock).toHaveBeenCalledWith("local:config", expect.objectContaining({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: expect.any(Number),
    }))
  })

  it("persists canonical config when stored config contains unsupported roots", async () => {
    const config = buildStableConfig()
    const staleConfig = {
      ...config,
      tts: { defaultVoice: "en-US-GuyNeural" },
      videoSubtitles: { enabled: true },
      selectionToolbar: { enabled: true },
    } as Config & Record<string, unknown>

    getItemMock.mockResolvedValueOnce(staleConfig)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: 79,
      lastModifiedAt: 888,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).toHaveBeenCalledTimes(1)
    expect(setItemMock).toHaveBeenCalledWith("local:config", config)
    expect(setMetaMock).toHaveBeenCalledTimes(1)
    expect(setMetaMock).toHaveBeenCalledWith("local:config", {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 888,
    })
  })

  it("only updates meta when config is unchanged but lastModifiedAt is missing", async () => {
    const config = buildStableConfig()
    getItemMock.mockResolvedValueOnce(config)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: CONFIG_SCHEMA_VERSION,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).not.toHaveBeenCalled()
    expect(setMetaMock).toHaveBeenCalledTimes(1)
    expect(setMetaMock).toHaveBeenCalledWith("local:config", expect.objectContaining({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: expect.any(Number),
    }))
  })

  it.each([
    {
      legacyModel: "deepseek-chat" as const,
      providerOptions: undefined,
      expectedProviderOptions: { thinking: { type: "disabled" } },
    },
    {
      legacyModel: "deepseek-chat" as const,
      providerOptions: { reasoningEffort: "high" },
      expectedProviderOptions: { reasoningEffort: "high", thinking: { type: "disabled" } },
    },
    {
      legacyModel: "deepseek-reasoner" as const,
      providerOptions: undefined,
      expectedProviderOptions: { thinking: { type: "enabled" } },
    },
    {
      legacyModel: "deepseek-reasoner" as const,
      providerOptions: { thinking: { type: "disabled" }, reasoningEffort: "high" },
      expectedProviderOptions: { thinking: { type: "disabled" }, reasoningEffort: "high" },
    },
  ])("migrates $legacyModel to DeepSeek V4 Flash without resetting config", async ({
    legacyModel,
    providerOptions,
    expectedProviderOptions,
  }) => {
    const legacyConfig = buildLegacyDeepSeekConfig(legacyModel, providerOptions)
    getItemMock.mockResolvedValueOnce(legacyConfig)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: 1,
      lastModifiedAt: 456,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    expect(setItemMock).toHaveBeenCalledTimes(1)
    const migratedConfig = setItemMock.mock.calls[0][1] as Config
    const deepseekProvider = getDeepSeekProvider(migratedConfig)
    expect(deepseekProvider.model.model).toBe("deepseek-v4-flash")
    expect(deepseekProvider.providerOptions).toEqual(expectedProviderOptions)
    expect(migratedConfig.language).toEqual(buildStableConfig().language)
    expect(loggerWarnMock).not.toHaveBeenCalled()
    expect(setMetaMock).toHaveBeenCalledWith("local:config", {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 456,
    })
  })

  it("does not change provider options for a custom DeepSeek model", async () => {
    const providerOptions = { thinking: { type: "enabled" }, customOption: true }
    const legacyConfig = buildLegacyDeepSeekConfig("deepseek-chat", providerOptions, true)
    getItemMock.mockResolvedValueOnce(legacyConfig)
    getMetaMock.mockResolvedValueOnce({
      schemaVersion: 1,
      lastModifiedAt: 789,
    })

    const { initializeConfig } = await import("../init")
    await initializeConfig()

    const migratedConfig = setItemMock.mock.calls[0][1] as Config
    const deepseekProvider = getDeepSeekProvider(migratedConfig)
    expect(deepseekProvider.model).toEqual({
      model: "deepseek-v4-flash",
      isCustomModel: true,
      customModel: "custom-deepseek-model",
    })
    expect(deepseekProvider.providerOptions).toEqual(providerOptions)
  })
})
