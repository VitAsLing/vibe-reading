import type { WritableAtom } from "jotai"
import type { CustomPromptsConfig, PromptAtoms, PromptConfigUpdate } from "./context"
import { atom } from "jotai"

interface ConfigWithCustomPrompts {
  customPromptsConfig: CustomPromptsConfig
}

export function createPromptAtoms<T extends ConfigWithCustomPrompts>(
  configAtom: WritableAtom<T, [Partial<T>], Promise<void>>,
): PromptAtoms {
  return {
    config: atom(
      get => get(configAtom).customPromptsConfig,
      (get, set, update: PromptConfigUpdate) => {
        const current = get(configAtom).customPromptsConfig
        const newConfig = typeof update === "function" ? update(current) : update
        return set(configAtom, { customPromptsConfig: newConfig } as Partial<T>)
      },
    ),
    exportMode: atom(false),
    selectedPrompts: atom<string[]>([]),
  }
}
