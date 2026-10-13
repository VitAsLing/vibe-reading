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
const pendingPatches = new Map<number, Partial<Config>>()

function confirmConfig(config: Config): void {
  confirmedConfig = config
  confirmationVersion++
}

function withPendingWrites(config: Config): Config {
  const next = [...pendingPatches.values()].reduce<Partial<Config>>((value, patch) => mergeWithArrayOverwrite(value, patch), config)
  const parsed = configSchema.safeParse(next)
  // An external commit can invalidate an unconfirmed collection edit. Keep
  // confirmed state until the background returns its explicit conflict.
  return parsed.success ? parsed.data : config
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
    const collectionBase = {
      ...(changedPatch.providersConfig !== undefined && { providersConfig: localPrev.providersConfig }),
      ...(changedPatch.translate?.customPromptsConfig !== undefined
        && { customPromptsConfig: localPrev.translate.customPromptsConfig }),
    }
    set(configAtom, optimisticNext)

    // Capture version for this write (used for stale-write detection later)
    const currentWriteVersion = ++writeVersion
    pendingPatches.set(currentWriteVersion, changedPatch)

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
        pendingPatches.delete(currentWriteVersion)
        if (isContentScriptActive())
          set(configAtom, withPendingWrites(confirmedConfig ?? localPrev))
      }
    })

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

// export const configFieldAtom = <K extends Keys>(key: K) => {
//   const readAtom = selectAtom(configAtom, (c) => c[key]); // 现在是同步
//   const writeAtom = atom(null, (_get, set, val: Config[K]) =>
//     set(writeConfigAtom, { [key]: val })
//   );
//   return [readAtom, writeAtom] as const;
// };

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
