import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek"
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai"
import type { JSONValue } from "ai"

export const LLM_PROVIDER_MODELS = {
  "openai": ["gpt-5.4-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-chat-latest", "gpt-5.2-pro", "gpt-5.2", "gpt-5.2-chat-latest", "gpt-5.1-codex-mini", "gpt-5.1-codex", "gpt-5.1", "gpt-5.1-chat-latest", "gpt-5-pro", "gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat-latest", "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
  "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "openai-compatible": ["use-custom-model"],
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
    pattern: /^deepseek-v4-(?:flash|pro)$/i,
    options: { thinking: { type: "disabled" } } satisfies DeepSeekLanguageModelOptions as Record<string, JSONValue>,
  },
]
