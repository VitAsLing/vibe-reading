import type { Config } from "@/types/config/config"
import type { ConfigMeta } from "@/types/config/meta"
import { dequal } from "dequal"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { initializeConfig } from "@/utils/config/init"
import { mergeWithArrayOverwrite } from "@/utils/config/merge"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { onMessage } from "@/utils/message"

let configPromise: Promise<void> | null = null

// To avoid background script initialize config simultaneously and avoid race condition
export async function ensureInitializedConfig() {
  if (!configPromise) {
    const initialization = initializeConfig().catch((error) => {
      if (configPromise === initialization)
        configPromise = null
      throw error
    })
    configPromise = initialization
  }
  await configPromise
  return storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
}

export function setupConfigurationMessages(): void {
  // A document-local queue cannot serialize writes from popup and options.
  // Register immediately so a save can also wake a cold background worker.
  let writeQueue: Promise<void> = Promise.resolve()
  onMessage("saveConfiguration", (message) => {
    const task = writeQueue.then(async () => {
      const { patch, collectionBase } = message.data
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Invalid configuration update")
      const current = configSchema.parse(await ensureInitializedConfig())
      // Whole collections carry their observed base. An obsolete editor must
      // fail explicitly instead of silently deleting another page's changes.
      if ((patch.providersConfig !== undefined && !dequal(collectionBase?.providersConfig, current.providersConfig))
        || (patch.translate?.customPromptsConfig !== undefined
          && !dequal(collectionBase?.customPromptsConfig, current.translate.customPromptsConfig))) {
        const error = new Error("Configuration changed in another page. Please retry.")
        error.name = "ConfigurationConflictError"
        throw error
      }
      if (Object.keys(patch).length === 0)
        return current
      const next = configSchema.parse(mergeWithArrayOverwrite(current, patch))
      const meta = await storage.getMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`)
      // WXT storage 1.2.8 uses `${key}$` for metadata. Both items share one
      // native local.set, so a failed save cannot commit only the value and
      // leave callers skipping the live-queue update after a metadata error.
      await storage.setItems([
        { key: `local:${CONFIG_STORAGE_KEY}`, value: next },
        { key: `local:${CONFIG_STORAGE_KEY}$`, value: { ...meta, lastModifiedAt: Date.now() } },
      ])
      return next
    })
    // The caller receives the original failure; subsequent independent saves
    // still get a fresh read and do not replay the failed patch.
    writeQueue = task.then(() => {}, () => {})
    return task
  })
}
