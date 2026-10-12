import type { Config } from "@/types/config/config"
import { deepmergeCustom } from "deepmerge-ts"
import { atom } from "jotai"
import { selectAtom } from "jotai/utils"
import { toast } from "sonner"
import { configSchema } from "@/types/config/config"
import { isContentScriptActive, isContentScriptInvalidationError, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { i18n } from "@/utils/i18n"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import { logger } from "../logger"
import { storageAdapter } from "./storage-adapter"

export const configAtom = atom<Config>(DEFAULT_CONFIG)

export const mergeWithArrayOverwrite = deepmergeCustom({
  // Use the last (source) array
  mergeArrays: values => values[values.length - 1],
})

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

/**
 * Global counter to detect stale writes.
 *
 * Each write captures its version at invocation time. After async storage completes,
 * we compare captured vs current version to determine if this is still the latest write.
 * This prevents older writes from overwriting the optimistic UI state.
 */
let writeVersion = 0
let confirmedConfig: Config | undefined

export const writeConfigAtom = atom(
  null,
  (get, set, patch: Partial<Config>) => {
    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Optimistic update (immediate UI feedback)
    // ─────────────────────────────────────────────────────────────────────────
    const localPrev = get(configAtom)
    confirmedConfig ??= localPrev
    const optimisticNext = mergeWithArrayOverwrite(localPrev, patch)
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
      // Always read fresh from storage to capture any writes that completed before us.
      // This ensures we don't lose concurrent field updates:
      //   write({x:1}) then write({y:2}) → storage ends up with {x:1, y:2}
      try {
        const configInStorage = await storageAdapter.get<Config>(CONFIG_STORAGE_KEY, DEFAULT_CONFIG, configSchema)
        confirmedConfig = configInStorage
        const nextToPersist = mergeWithArrayOverwrite(configInStorage, patch)
        // Storage write always executes (not affected by version check)
        await storageAdapter.set(CONFIG_STORAGE_KEY, nextToPersist, configSchema)
        confirmedConfig = nextToPersist
        await storageAdapter.setMeta(CONFIG_STORAGE_KEY, { lastModifiedAt: Date.now() })

        // ───────────────────────────────────────────────────────────────────
        // STEP 3: Reconcile atom with persisted value (stale-write check)
        // ───────────────────────────────────────────────────────────────────
        // Only update atom if no newer writes happened since we started.
        // If a newer write exists, its optimistic update already set the correct UI state,
        // so we skip to avoid "flashing back" to this older value.
        if (currentWriteVersion === writeVersion) {
          set(configAtom, nextToPersist)
        }
      }
      catch (error) {
        logger.warn("Failed to confirm configuration save:", error)

        // Roll back to storage value on error, but only if we're still the latest write.
        if (currentWriteVersion === writeVersion) {
          set(configAtom, confirmedConfig ?? localPrev)
        }

        throw error
      }
    })

    // Handle failure on the queue head so subsequent writes can still run.
    // Return the original handled promise. Awaiting callers still receive the
    // failure; settings callbacks that ignore it cannot create a second,
    // unhandled async wrapper or silently leave optimistic values in the UI.
    writeQueue = task.catch((error) => {
      if (!isContentScriptInvalidationError(error)) {
        toast.error(i18n.t("errorRecovery.saveFailed"))
      }
    })

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
        confirmedConfig = value
        setAtom(value)
      }
    }, "Failed to load configuration:")
  }
  refresh()

  // Watch for changes from other extension contexts (popup, options page, other tabs)
  const unwatch = storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, (value) => {
    if (!mounted || !isContentScriptActive())
      return
    readVersion++
    confirmedConfig = value
    setAtom(value)
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
