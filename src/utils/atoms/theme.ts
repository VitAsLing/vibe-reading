import type { ThemeMode } from "@/types/config/theme"
import { atom } from "jotai"
import { DEFAULT_THEME_MODE, themeModeSchema } from "@/types/config/theme"
import { isContentScriptActive, runContentScriptTask } from "@/utils/content-script/lifecycle"
import { THEME_STORAGE_KEY } from "../constants/config"
import { logger } from "../logger"
import { storageAdapter } from "./storage-adapter"

// Private base atom. Only export this for top-level hydration before ThemeProvider mounts.
export const baseThemeModeAtom = atom<ThemeMode>(DEFAULT_THEME_MODE)

// Public atom with read/write - write always goes through storageAdapter
export const themeModeAtom = atom(
  get => get(baseThemeModeAtom),
  async (get, set, newValue: ThemeMode) => {
    const prev = get(baseThemeModeAtom)
    set(baseThemeModeAtom, newValue)
    try {
      await storageAdapter.set(THEME_STORAGE_KEY, newValue, themeModeSchema)
    }
    catch (error) {
      console.error("Failed to set themeMode to storage:", newValue, error)
      set(baseThemeModeAtom, prev)
    }
  },
)

baseThemeModeAtom.onMount = (setAtom: (newValue: ThemeMode) => void) => {
  let mounted = true
  const refresh = () => {
    runContentScriptTask(async () => {
      const value = await storageAdapter.get<ThemeMode>(THEME_STORAGE_KEY, DEFAULT_THEME_MODE, themeModeSchema)
      if (mounted && isContentScriptActive()) {
        setAtom(value)
      }
    }, "Failed to load theme:")
  }
  refresh()
  const unwatch = storageAdapter.watch<ThemeMode>(THEME_STORAGE_KEY, (value) => {
    if (mounted && isContentScriptActive()) {
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
