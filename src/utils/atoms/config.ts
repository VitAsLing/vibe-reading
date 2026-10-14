import type { Config } from "@/types/config/config"
import { atom } from "jotai"
import { selectAtom } from "jotai/utils"
import { toast } from "sonner"
import { configSchema } from "@/types/config/config"
import { getChangedConfigFields, mergeWithArrayOverwrite } from "@/utils/config/merge"
import { isContentScriptActive, isContentScriptInvalidationError, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import { logger } from "../logger"
import { storageAdapter } from "./storage-adapter"

export const configAtom = atom<Config>(DEFAULT_CONFIG)

export { mergeWithArrayOverwrite } from "@/utils/config/merge"

/**
 * Promise-chain queue for serializing storage writes.
 *
 * Each write chains onto the previous via `.then()`, ensuring sequential execution:
 *   Promise.resolve() → task1 → task2 → task3 → ...
 *
 * This prevents race conditions when multiple writes happen in quick succession.
 * Even if a write fails, the queue reports it and continues.
 */
let writeQueue: Promise<void> = Promise.resolve()

// Writes invalidate older hydration reads. Storage observations also take
// ownership from delayed save acknowledgements in this document.
let writeVersion = 0
let confirmedConfig: Config | undefined
let confirmationVersion = 0
const pendingWrites = new Map<number, { patch: Partial<Config>, task: Promise<void> }>()

function confirmConfig(config: Config): void {
  confirmedConfig = config
  confirmationVersion++
}

function withPendingWrites(config: Config): Config {
  const next = [...pendingWrites.values()].reduce<Partial<Config>>((value, { patch }) => mergeWithArrayOverwrite(value, patch), config)
  const parsed = configSchema.safeParse(next)
  // An external commit can invalidate an unconfirmed collection edit. Keep
  // confirmed state until the background returns its explicit conflict.
  return parsed.success ? parsed.data : config
}

function getConfigPatchField(patch: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) =>
    current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, patch)
}

function getPendingWriteTasks(patch: Partial<Config>): Promise<void>[] {
  const writes = [...pendingWrites.values()].reverse()
  const tasks = new Set<Promise<void>>()
  const visit = (value: unknown, path: string[]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value))
        visit(child, [...path, key])
    }
    else {
      const owner = writes.find(write => getConfigPatchField(write.patch, path) !== undefined)
      if (owner)
        tasks.add(owner.task)
    }
  }
  visit(patch, [])
  return [...tasks]
}

function reportSaveFailure(error: unknown): void {
  if (!isContentScriptInvalidationError(error))
    toast.error(i18n.t("errorRecovery.saveFailed"))
}

export const writeConfigAtom = atom(
  null,
  (get, set, patch: Partial<Config>) => {
    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Optimistic update (immediate UI feedback)
    // ─────────────────────────────────────────────────────────────────────────
    const localPrev = get(configAtom)
    confirmedConfig ??= localPrev
    // Validate external/editor input before React sees optimistic values.
    // A malformed import must never render an object as a prompt's name.
    const parsed = configSchema.safeParse(mergeWithArrayOverwrite(localPrev, patch))
    if (!parsed.success) {
      const failure = Promise.reject(parsed.error)
      void failure.catch(reportSaveFailure)
      return failure
    }
    const optimisticNext = parsed.data
    const changedPatch = getChangedConfigFields(localPrev, optimisticNext)
    if (Object.keys(changedPatch).length === 0) {
      // Fields queued back to a confirmed value still have a pending owner.
      const tasks = getPendingWriteTasks(patch)
      if (tasks.length === 1)
        return tasks[0]
      if (tasks.length > 1) {
        const receipt = Promise.all(tasks).then(() => {})
        // Original owners report failures; ignored joined receipts also need a handler.
        void receipt.catch(() => {})
        return receipt
      }
    }
    const collectionBase = {
      ...(changedPatch.providersConfig !== undefined && { providersConfig: localPrev.providersConfig }),
      ...(changedPatch.translate?.customPromptsConfig !== undefined
        && { customPromptsConfig: localPrev.translate.customPromptsConfig }),
    }
    set(configAtom, optimisticNext)

    // Capture version for this write (used for stale-write detection later)
    const currentWriteVersion = ++writeVersion

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Queue the actual storage write
    // ─────────────────────────────────────────────────────────────────────────
    // Chain onto writeQueue so writes execute in order.
    // Note: `.then(callback)` schedules callback to microtask queue (async),
    // but `writeQueue = task` assignment happens synchronously.
    const task = writeQueue.then(async () => {
      const observedVersion = confirmationVersion
      try {
        // The background owns the fresh read, merge and persistence across all
        // documents; each document still preserves its own submission order.
        const nextToPersist = await sendMessage("saveConfiguration", { patch: changedPatch, collectionBase })
        if (confirmationVersion === observedVersion)
          confirmConfig(nextToPersist)
      }
      catch (error) {
        logger.warn("Failed to confirm configuration save:", error)
        throw error
      }
      finally {
        pendingWrites.delete(currentWriteVersion)
        if (isContentScriptActive())
          set(configAtom, withPendingWrites(confirmedConfig ?? localPrev))
      }
    })
    pendingWrites.set(currentWriteVersion, { patch: changedPatch, task })

    // Handle failure on the queue head so subsequent writes can still run.
    // Return the original handled promise. Awaiting callers still receive the
    // failure; settings callbacks that ignore it cannot create a second,
    // unhandled async wrapper or silently leave optimistic values in the UI.
    writeQueue = task.catch(reportSaveFailure)

    return task
  },
)

/**
 * Initialize atom state from storage and set up cross-context sync.
 *
 * This handles three sync scenarios:
 * 1. Initial load: Read from storage when atom first mounts
 * 2. Cross-context updates: Watch for changes from other extension contexts (popup, options, etc.)
 * 3. Tab reactivation: Reload when tab becomes visible (inactive tabs may miss watch events)
 */
configAtom.onMount = (setAtom: (newValue: Config) => void) => {
  let readVersion = 0
  let mounted = true

  const refresh = () => {
    const version = ++readVersion
    const currentWriteVersion = writeVersion
    runContentScriptTask(async () => {
      const value = await storageAdapter.get<Config>(CONFIG_STORAGE_KEY, DEFAULT_CONFIG, configSchema)
      if (mounted && isContentScriptActive() && version === readVersion && currentWriteVersion === writeVersion) {
        confirmConfig(value)
        setAtom(withPendingWrites(value))
      }
    }, "Failed to load configuration:")
  }
  refresh()

  // Watch for changes from other extension contexts (popup, options page, other tabs)
  const unwatch = storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, (value) => {
    if (!mounted || !isContentScriptActive())
      return
    readVersion++
    confirmConfig(value)
    setAtom(withPendingWrites(value))
  })

  // Handle tab reactivation - inactive tabs may miss storage watch events,
  // so we reload from storage when the tab becomes visible again.
  // Historical regression
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      logger.info("configAtom onMount handleVisibilityChange when: ", new Date())
      refresh()
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange)

  return () => {
    mounted = false
    unwatch()
    document.removeEventListener("visibilitychange", handleVisibilityChange)
  }
}

type Keys = keyof Config

export function getConfigFieldAtom<K extends Keys>(key: K) {
  // If you don't mind "re-rendering when other fields are changed"
  // you can directly get(configAtom)[key] instead of using selectAtom.
  const sliceAtom = selectAtom(configAtom, c => c[key])

  return atom(
    get => get(sliceAtom),
    (_get, set, newVal: Partial<Config[K]>) =>
      set(writeConfigAtom, { [key]: newVal }),
  )
}

function buildConfigFieldsAtomMap<C extends Config>(cfg: C) {
  type ValidKey = Extract<keyof C, keyof Config>
  type Map = { [K in ValidKey]: ReturnType<typeof getConfigFieldAtom<K>> }

  const res = {} as Map

  const add = <K extends ValidKey>(key: K) => {
    res[key] = getConfigFieldAtom(key)
  };

  (Object.keys(cfg) as ValidKey[]).forEach(add)
  return res
}

export const configFieldsAtomMap = buildConfigFieldsAtomMap(DEFAULT_CONFIG)
