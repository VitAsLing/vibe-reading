import type { TranslatePromptObj } from "@/types/config/translate"
import { Icon } from "@iconify/react/dist/iconify.js"
import { dequal } from "dequal"
import { useAtom, useAtomValue } from "jotai"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/base-ui/alert-dialog"
import { Button } from "@/components/ui/base-ui/button"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { usePromptAtoms } from "./context"

export function DeletePrompt({
  originPrompt,
  className,
  ...props
}: {
  originPrompt: TranslatePromptObj
  className?: string
} & React.ComponentProps<"button">) {
  const promptAtoms = usePromptAtoms()
  const isExportMode = useAtomValue(promptAtoms.exportMode)
  const [, setConfig] = useAtom(promptAtoms.config)

  const [open, setOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const deletePrompt = async () => {
    if (isDeleting)
      return
    setIsDeleting(true)
    try {
      await setConfig((current) => {
        if (!dequal(current.patterns.find(item => item.id === originPrompt.id), originPrompt)) {
          toast.error(i18n.t("errorRecovery.saveFailed"))
          throw new Error("The prompt changed before it could be deleted")
        }
        return {
          ...current,
          patterns: current.patterns.filter(p => p.id !== originPrompt.id),
          promptId: current.promptId !== originPrompt.id ? current.promptId : null,
        }
      })
      setOpen(false)
    }
    catch (error) {
      logger.warn("Prompt deletion did not complete:", error)
    }
    finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="ghost" size="icon" className={className} disabled={isExportMode} {...props} />}>
        <Icon icon="tabler:trash" className="size-4"></Icon>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {i18n.t("options.translation.personalizedPrompts.deletePrompt.title")}
            {" "}
            :
            {" "}
            {originPrompt.name}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {i18n.t("options.translation.personalizedPrompts.deletePrompt.description")}
            {" "}
            ?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{i18n.t("options.translation.personalizedPrompts.deletePrompt.cancel")}</AlertDialogCancel>
          <Button disabled={isDeleting} onClick={deletePrompt}>{i18n.t("options.translation.personalizedPrompts.deletePrompt.confirm")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
