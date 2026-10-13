import type { PartialDeep } from "type-fest"
import type { ProviderConfig } from "@/types/config/provider"
import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { updateLLMProviderConfig } from "../provider"

type OpenAIProviderConfig = Extract<ProviderConfig, { provider: "openai" }>

describe("provider config updates", () => {
  it("merges nested LLM model updates without changing untouched fields", () => {
    const result = updateLLMProviderConfig(DEFAULT_PROVIDER_CONFIG.openai, {
      model: {
        customModel: "gpt-5-custom",
        isCustomModel: true,
      },
    })

    expect(result.model).toEqual({
      ...DEFAULT_PROVIDER_CONFIG.openai.model,
      customModel: "gpt-5-custom",
      isCustomModel: true,
    })
    expect(result.provider).toBe("openai")
  })

  it("merges provider option objects and preserves the rest of the config", () => {
    const result = updateLLMProviderConfig(DEFAULT_PROVIDER_CONFIG.openai, {
      providerOptions: {
        reasoningEffort: "minimal",
      },
    }) as OpenAIProviderConfig

    expect(result.providerOptions).toEqual({ reasoningEffort: "minimal" })
    expect(result.model).toEqual(DEFAULT_PROVIDER_CONFIG.openai.model)
    expect(result.provider).toBe("openai")
  })

  it("merges provider headers and preserves the rest of the config", () => {
    const result = updateLLMProviderConfig(DEFAULT_PROVIDER_CONFIG.openai, {
      headers: {
        "X-Test": "1",
      },
    }) as OpenAIProviderConfig

    expect(result.headers).toEqual({ "X-Test": "1" })
    expect(result.model).toEqual(DEFAULT_PROVIDER_CONFIG.openai.model)
    expect(result.provider).toBe("openai")
  })

  it("rejects merged configs that no longer match the provider schema", () => {
    const invalidUpdates = {
      provider: "openai",
    } as PartialDeep<ProviderConfig>

    expect(() => updateLLMProviderConfig(DEFAULT_PROVIDER_CONFIG.deepseek, invalidUpdates)).toThrow()
  })
})
