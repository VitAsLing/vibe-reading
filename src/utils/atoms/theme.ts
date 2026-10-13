import type { ThemeMode } from "@/types/config/theme"
import { atom } from "jotai"
import { toast } from "sonner"
import { DEFAULT_THEME_MODE, themeModeSchema } from "@/types/config/theme"
import { isContentScriptActive, isContentScriptInvalidationError, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { i18n } from "@/utils/i18n"
import { THEME_STORAGE_KEY } from "../constants/config"
import { logger } from "../logger"
import { storageAdapter } from "./storage-adapter"

// Private base atom. Only export this for top-level hydration before ThemeProvider mounts.
export const baseThemeModeAtom = atom<ThemeMode>(DEFAULT_THEME_MODE)
let writeVersion = 0
let confirmedThemeMode: ThemeMode | undefined
let confirmedVersion = 0

// Public atom with read/write - write always goes through storageAdapter
export const themeModeAtom = atom(
  get => get(baseThemeModeAtom),
  async (get, set, newValue: ThemeMode) => {
    const prev = get(baseThemeModeAtom)
    confirmedThemeMode ??= prev
    const version = ++writeVersion
    const observedVersion = confirmedVersion
    set(baseThemeModeAtom, newValue)
    try {
      await storageAdapter.set(THEME_STORAGE_KEY, newValue, themeModeSchema)
      if (observedVersion === confirmedVersion && isContentScriptActive()) {
        confirmedThemeMode = newValue
        confirmedVersion++
      }
    }
    catch (error) {
      if (isContentScriptInvalidationError(error))
        return
      logger.warn("Failed to save theme:", error)
      if (version === writeVersion && isContentScriptActive())
        set(baseThemeModeAtom, confirmedThemeMode)
      toast.error(i18n.t("errorRecovery.saveFailed"))
    }
  },
)

baseThemeModeAtom.onMount = (setAtom: (newValue: ThemeMode) => void) => {
  let mounted = true
  let readVersion = 0
  const refresh = () => {
    const version = ++readVersion
    const currentWriteVersion = writeVersion
    runContentScriptTask(async () => {
      const value = await storageAdapter.get<ThemeMode>(THEME_STORAGE_KEY, DEFAULT_THEME_MODE, themeModeSchema)
      if (mounted && isContentScriptActive() && version === readVersion && currentWriteVersion === writeVersion) {
        confirmedThemeMode = value
        confirmedVersion++
        setAtom(value)
      }
    }, "Failed to load theme:")
  }
  refresh()
  const unwatch = storageAdapter.watch<ThemeMode>(THEME_STORAGE_KEY, (value) => {
    if (mounted && isContentScriptActive()) {
      readVersion++
      confirmedThemeMode = value
      confirmedVersion++
      setAtom(value)
    }
  })

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      logger.info("baseThemeModeAtom onMount handleVisibilityChange when: ", new Date())
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
