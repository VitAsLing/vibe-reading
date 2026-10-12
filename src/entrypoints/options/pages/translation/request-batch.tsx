import type { BatchQueueConfig } from "@/types/config/translate"
import { useAtom } from "jotai"
import { toast } from "sonner"
import { HelpTooltip } from "@/components/help-tooltip"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/base-ui/field"
import { Input } from "@/components/ui/base-ui/input"
import { batchQueueConfigSchema } from "@/types/config/translate"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { MIN_BATCH_CHARACTERS, MIN_BATCH_ITEMS } from "@/utils/constants/translate"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { ConfigCard } from "../../components/config-card"

type KeyOfBatchQueueConfig = keyof BatchQueueConfig

export function RequestBatch() {
  return (
    <ConfigCard
      id="request-batch"
      title={i18n.t("options.translation.batchQueueConfig.title")}
      description={i18n.t("options.translation.batchQueueConfig.description")}
    >
      <FieldGroup>
        <BatchNumberSelector property="maxCharactersPerBatch" />
        <BatchNumberSelector property="maxItemsPerBatch" />
      </FieldGroup>
    </ConfigCard>
  )
}

const propertyInfo = {
  maxCharactersPerBatch: {
    label: i18n.t("options.translation.batchQueueConfig.maxCharactersPerBatch.title"),
    description: i18n.t("options.translation.batchQueueConfig.maxCharactersPerBatch.description"),
  },
  maxItemsPerBatch: {
    label: i18n.t("options.translation.batchQueueConfig.maxItemsPerBatch.title"),
    description: i18n.t("options.translation.batchQueueConfig.maxItemsPerBatch.description"),
  },
}

const propertyMinValue = {
  maxCharactersPerBatch: MIN_BATCH_CHARACTERS,
  maxItemsPerBatch: MIN_BATCH_ITEMS,
}

function BatchNumberSelector({ property }: { property: KeyOfBatchQueueConfig }) {
  const [translateConfig, setTranslateConfig] = useAtom(configFieldsAtomMap.translate)
  const { batchQueueConfig } = translateConfig

  const currentConfigValue = batchQueueConfig[property]
  const minAllowedValue = propertyMinValue[property]

  const info = propertyInfo[property]

  const applyConfigValue = async (newConfigValue: number) => {
    let saveConfirmed = false
    try {
      await setTranslateConfig({
        batchQueueConfig: {
          ...translateConfig.batchQueueConfig,
          [property]: newConfigValue,
        },
      })
      saveConfirmed = true
      await sendMessage("setTranslateBatchQueueConfig", {
        [property]: newConfigValue,
      })
    }
    catch (error) {
      logger.warn("Translation batch settings could not be applied:", error)
      if (saveConfirmed) {
        toast.error(error instanceof Error ? error.message : i18n.t("errorRecovery.title"))
      }
    }
  }

  return (
    <Field orientation="responsive">
      <FieldContent className="self-center">
        <FieldLabel htmlFor={`batch-${property}`}>
          {info.label}
          <HelpTooltip>{info.description}</HelpTooltip>
        </FieldLabel>
      </FieldContent>
      <Input
        id={`batch-${property}`}
        className="w-40 shrink-0"
        type="number"
        min={minAllowedValue}
        value={currentConfigValue}
        onChange={(e) => {
          const newConfigValue = Number(e.target.value)
          const configParseResult = batchQueueConfigSchema.partial().safeParse({ [property]: newConfigValue })
          if (configParseResult.success) {
            void applyConfigValue(newConfigValue)
          }
          else {
            toast.error(configParseResult.error?.issues[0].message)
          }
        }}
      />
    </Field>
  )
}
