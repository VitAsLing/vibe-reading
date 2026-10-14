import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek"
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai"
import type { JSONValue } from "ai"

export const LLM_PROVIDER_MODELS = {
  // API model catalog and shutdown dates checked on 2026-10-15:
  // https://developers.openai.com/api/docs/models
  // https://developers.openai.com/api/docs/deprecations
  "openai": [
    "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-sol",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5-pro", "gpt-5.5",
    "gpt-5.4-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.2-pro", "gpt-5.2", "gpt-5.1", "gpt-5-pro", "gpt-5", "gpt-5-mini", "gpt-5-nano",
    "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o",
  ],
  "deepseek": ["deepseek-flash", "deepseek-v4-pro"],
  "openai-compatible": ["use-custom-model"],
} as const

// Preserve saved selections without presenting shut-down models as new choices.
// Replacements are guidance for an explicit user selection, never an automatic migration.
export const RETIRED_OPENAI_MODELS = {
  "gpt-5-chat-latest": { shutdownDate: "2026-07-23", replacement: "gpt-5.6-sol" },
  "gpt-5-codex": { shutdownDate: "2026-07-23", replacement: "gpt-5.6-sol" },
  "gpt-5.1-chat-latest": { shutdownDate: "2026-07-23", replacement: "gpt-5.6-sol" },
  "gpt-5.1-codex": { shutdownDate: "2026-07-23", replacement: "gpt-5.6-sol" },
  "gpt-5.1-codex-mini": { shutdownDate: "2026-07-23", replacement: "gpt-5.6-terra" },
  "gpt-5.2-chat-latest": { shutdownDate: "2026-08-10", replacement: "gpt-5.6-sol" },
  "gpt-5.3-chat-latest": { shutdownDate: "2026-08-10", replacement: "gpt-5.6-sol" },
} as const

export const RETIRED_DEEPSEEK_MODELS = {
  "deepseek-chat": { shutdownDate: "2026-07-24", replacement: "deepseek-flash" },
  "deepseek-reasoner": { shutdownDate: "2026-07-24", replacement: "deepseek-flash" },
} as const

export const RETIRED_PROVIDER_MODELS = {
  openai: RETIRED_OPENAI_MODELS,
  deepseek: RETIRED_DEEPSEEK_MODELS,
} as const

export const LLM_PROVIDER_MODEL_IDS = {
  ...LLM_PROVIDER_MODELS,
  openai: [...LLM_PROVIDER_MODELS.openai, ...Object.keys(RETIRED_OPENAI_MODELS) as (keyof typeof RETIRED_OPENAI_MODELS)[]],
  deepseek: [...LLM_PROVIDER_MODELS.deepseek, "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", ...Object.keys(RETIRED_DEEPSEEK_MODELS) as (keyof typeof RETIRED_DEEPSEEK_MODELS)[]],
} as const

/**
 * First match wins. Keep pattern order stable: the UI uses the match index
 * to distinguish recommendation groups when the selected model changes.
 */
export const LLM_MODEL_OPTIONS: Array<{
  pattern: RegExp
  options: Record<string, JSONValue>
}> = [
  {
    pattern: /^(?:gpt-6-astra|gpt-6\.1-sol)$/i,
    // The installed SDK does not recognize GPT-6 reasoning models by ID yet.
    options: { forceReasoning: true, reasoningEffort: "low" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-6-(?:sol|luna)$/i,
    options: { forceReasoning: true, reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.6-(?:sol|terra|luna)$/i,
    options: { reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.5-pro$/i,
    options: { reasoningEffort: "medium" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.5$/i,
    options: { reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^(?:o1|o3|o4-mini)(?:-|$)/i,
    options: { reasoningEffort: "minimal" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.4-pro$/i,
    options: { reasoningEffort: "medium" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.2-pro$/i,
    options: { reasoningEffort: "medium" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5-pro$/i,
    options: { reasoningEffort: "high" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^(?:gpt-5\.4|gpt-5\.4-mini|gpt-5\.4-nano)$/i,
    options: { reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^gpt-5\.2$/i,
    options: { reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^(?:gpt-5\.1|gpt-5\.1-codex|gpt-5\.1-codex-mini)$/i,
    options: { reasoningEffort: "none" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^(?:gpt-5|gpt-5-mini|gpt-5-nano|gpt-5-codex)$/i,
    options: { reasoningEffort: "minimal" } satisfies OpenAIResponsesProviderOptions as Record<string, JSONValue>,
  },
  {
    pattern: /^(?:deepseek-flash|deepseek-v4-(?:flash|pro|flash-vision-exp))$/i,
    options: { thinking: { type: "disabled" } } satisfies DeepSeekLanguageModelOptions as Record<string, JSONValue>,
  },
]
