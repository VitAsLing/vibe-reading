import type { PromptConfigList } from "./utils/prompt-file"
import { Icon } from "@iconify/react/dist/iconify.js"
import { useSetAtom } from "jotai"
import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { Label } from "@/components/ui/base-ui/label"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { usePromptAtoms } from "./context"
import { analysisJSONFile } from "./utils/prompt-file"

export function ImportPrompts() {
  const promptAtoms = usePromptAtoms()
  const setConfig = useSetAtom(promptAtoms.config)
  const inputId = useId()
  const [isImporting, setIsImporting] = useState(false)
  const operationVersionRef = useRef(0)
  useEffect(() => () => {
    operationVersionRef.current++
  }, [])

  const injectPrompts = (list: PromptConfigList) => {
    const patterns = list.map(item => ({
      ...item,
      id: getRandomUUID(),
      // Backwards compatibility: add systemPrompt if missing from imported file
      systemPrompt: item.systemPrompt ?? "",
    }))

    return setConfig(current => ({
      ...current,
      patterns: [...current.patterns, ...patterns],
    }))
  }

  const importPrompts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const file = input.files?.[0]
    if (!file || isImporting)
      return
    const version = ++operationVersionRef.current
    setIsImporting(true)
    try {
      const promptConfig = await analysisJSONFile(file)
      if (version !== operationVersionRef.current)
        return
      await injectPrompts(promptConfig)
      if (version === operationVersionRef.current)
        toast.success(`${i18n.t("options.translation.personalizedPrompts.importSuccess")} !`)
    }
    catch (error) {
      if (version !== operationVersionRef.current)
        return
      if (error instanceof Error) {
        toast.error(error.message)
      }
      else {
        toast.error("Something went error when importing")
      }
    }
    finally {
      input.value = ""
      input.files = null
      if (version === operationVersionRef.current)
        setIsImporting(false)
    }
  }

  return (
    <Button variant="outline" className="p-0" disabled={isImporting}>
      <Label htmlFor={inputId} className="w-full px-3">
        <Icon icon="tabler:file-import" className="size-4" />
        {i18n.t("options.translation.personalizedPrompts.import")}
      </Label>
      <Input
        type="file"
        id={inputId}
        className="hidden"
        accept=".json"
        disabled={isImporting}
        onChange={importPrompts}
      />
    </Button>
  )
}
