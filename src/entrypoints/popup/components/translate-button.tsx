import { useAtom, useAtomValue } from "jotai"
import { useState } from "react"
import { toast } from "sonner"
import { browser, i18n } from "#imports"
import { Button } from "@/components/ui/base-ui/button"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { formatHotkey } from "@/utils/os.ts"
import { isPageTranslationShortcutEmpty } from "@/utils/page-translation-shortcut"
import { cn } from "@/utils/styles/utils"
import { isPageTranslatedAtom } from "../atoms/auto-translate"
import { isIgnoreTabAtom } from "../atoms/ignore"

export default function TranslateButton({ className }: { className?: string }) {
  const [isPageTranslated, setIsPageTranslated] = useAtom(isPageTranslatedAtom)
  const isIgnoreTab = useAtomValue(isIgnoreTabAtom)
  const translateConfig = useAtomValue(configFieldsAtomMap.translate)
  const [isToggling, setIsToggling] = useState(false)

  const toggleTranslation = async () => {
    if (isToggling)
      return
    setIsToggling(true)
    try {
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
      if (currentTab?.id === undefined) {
        throw new Error("No active tab is available")
      }
      const nextEnabled = !isPageTranslated
      const actualEnabled = await sendMessage("tryToSetEnablePageTranslationByTabId", {
        tabId: currentTab.id,
        enabled: nextEnabled,
      })
      if (typeof actualEnabled !== "boolean") {
        throw new TypeError("Page translation status could not be confirmed. Refresh the page and try again.")
      }
      setIsPageTranslated(actualEnabled)
      if (actualEnabled !== nextEnabled) {
        throw new Error("Page translation could not be changed. Check translation settings and try again.")
      }
    }
    catch (error) {
      logger.warn("Page translation request did not complete:", error)
      toast.error(error instanceof Error ? error.message : i18n.t("errorRecovery.title"))
    }
    finally {
      setIsToggling(false)
    }
  }

  const isDisabled = isIgnoreTab
  const formattedShortcut = formatHotkey(translateConfig.page.shortcut)
  const shortcutSuffix = isPageTranslationShortcutEmpty(translateConfig.page.shortcut) ? "" : ` (${formattedShortcut})`

  return (
    <Button
      onClick={toggleTranslation}
      disabled={isDisabled || isToggling}
      className={cn(
        "block truncate",
        className,
      )}
    >
      {isPageTranslated
        ? i18n.t("popup.showOriginal")
        : `${i18n.t("popup.translate")}${shortcutSuffix}`}
    </Button>
  )
}
