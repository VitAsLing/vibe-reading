import type { TranslatePromptObj } from "@/types/config/translate"
import { Icon } from "@iconify/react"
import { dequal } from "dequal"
import { useAtom, useAtomValue } from "jotai"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/base-ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/base-ui/field"
import { Input } from "@/components/ui/base-ui/input"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/base-ui/sheet"
import { QuickInsertableTextarea } from "@/components/ui/insertable-textarea"
import { DEFAULT_TRANSLATE_PROMPT_ID } from "@/utils/constants/prompt"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { cn } from "@/utils/styles/utils"
import { usePromptAtoms, usePromptInsertCells } from "./context"

export function ConfigurePrompt({
  originPrompt,
  className,
  ...props
}: {
  originPrompt?: TranslatePromptObj
  className?: string
} & React.ComponentProps<"button">) {
  const promptAtoms = usePromptAtoms()
  const insertCells = usePromptInsertCells()
  const [, setConfig] = useAtom(promptAtoms.config)
  const isExportMode = useAtomValue(promptAtoms.exportMode)

  const inEdit = !!originPrompt
  const isDefault = originPrompt?.id === DEFAULT_TRANSLATE_PROMPT_ID

  const defaultPrompt = { id: getRandomUUID(), name: "", systemPrompt: "", prompt: "" }
  const initialPrompt = originPrompt ?? defaultPrompt

  const [prompt, setPrompt] = useState<TranslatePromptObj>(initialPrompt)
  const originalPromptRef = useRef(initialPrompt)
  const [open, setOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resetPrompt = () => {
    const original = originPrompt ?? defaultPrompt
    originalPromptRef.current = original
    setPrompt(original)
  }

  const sheetTitle = isDefault
    ? i18n.t("options.translation.personalizedPrompts.default")
    : inEdit
      ? i18n.t("options.translation.personalizedPrompts.editPrompt.title")
      : i18n.t("options.translation.personalizedPrompts.addPrompt")

  const clearCachePrompt = () => {
    setPrompt({
      id: getRandomUUID(),
      name: "",
      systemPrompt: "",
      prompt: "",
    })
  }

  const configurePrompt = async () => {
    if (isSaving)
      return
    setIsSaving(true)
    try {
      await setConfig((current) => {
        if (inEdit && !dequal(current.patterns.find(item => item.id === prompt.id), originalPromptRef.current)) {
          toast.error(i18n.t("errorRecovery.saveFailed"))
          throw new Error("The prompt changed while its editor was open")
        }
        return {
          ...current,
          patterns: inEdit
            ? current.patterns.map(p => p.id === prompt.id ? prompt : p)
            : [...current.patterns, prompt],
        }
      })
      if (mountedRef.current) {
        clearCachePrompt()
        setOpen(false)
      }
    }
    catch (error) {
      logger.warn("Prompt save did not complete:", error)
    }
    finally {
      if (mountedRef.current)
        setIsSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (isSaving)
          return
        setOpen(nextOpen)
        if (nextOpen) {
          resetPrompt()
        }
      }}
    >
      {inEdit
        ? (
            <SheetTrigger render={<Button variant="ghost" className={cn("size-8", className)} disabled={isExportMode} {...props} />}>
              <Icon icon={isDefault ? "tabler:eye" : "tabler:pencil"} className="size-4" />
            </SheetTrigger>
          )
        : (
            <SheetTrigger render={<Button className={className} {...props} />}>
              <Icon icon="tabler:plus" className="size-4" />
              {i18n.t("options.translation.personalizedPrompts.addPrompt")}
            </SheetTrigger>
          )}
      <SheetContent className="w-[400px] sm:w-[500px] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{sheetTitle}</SheetTitle>
        </SheetHeader>
        <FieldGroup className="flex-1 overflow-y-auto px-4">
          <Field>
            <FieldLabel htmlFor="prompt-name">{i18n.t("options.translation.personalizedPrompts.editPrompt.name")}</FieldLabel>
            <Input
              id="prompt-name"
              value={prompt.name}
              disabled={isDefault || isSaving}
              onChange={(e) => {
                setPrompt({
                  ...prompt,
                  name: e.target.value,
                })
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="system-prompt">{i18n.t("options.translation.personalizedPrompts.editPrompt.systemPrompt")}</FieldLabel>
            <QuickInsertableTextarea
              value={prompt.systemPrompt}
              className="min-h-40 max-h-80"
              disabled={isDefault || isSaving}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt({ ...prompt, systemPrompt: e.target.value })}
              insertCells={insertCells}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="prompt">{i18n.t("options.translation.personalizedPrompts.editPrompt.prompt")}</FieldLabel>
            <QuickInsertableTextarea
              value={prompt.prompt}
              className="max-h-60"
              disabled={isDefault || isSaving}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt({ ...prompt, prompt: e.target.value })}
              insertCells={insertCells}
            />
          </Field>
        </FieldGroup>
        {!isDefault && (
          <SheetFooter>
            <Button onClick={configurePrompt} disabled={isSaving}>
              {i18n.t("options.translation.personalizedPrompts.editPrompt.save")}
            </Button>
            <SheetClose render={<Button variant="outline" disabled={isSaving} />}>
              {i18n.t("options.translation.personalizedPrompts.editPrompt.close")}
            </SheetClose>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
