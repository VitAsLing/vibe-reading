import type { UILocale } from "@/types/config/config"
import { Icon } from "@iconify/react"
import { useAtomValue, useSetAtom } from "jotai"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-ui/select"
import { configFieldsAtomMap, writeConfigAtom } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { ConfigCard } from "../../components/config-card"

const UI_LOCALE_ITEMS: Array<{
  value: UILocale
  labelKey: "options.general.interfaceLanguage.english" | "options.general.interfaceLanguage.simplifiedChinese"
}> = [
  {
    value: "en",
    labelKey: "options.general.interfaceLanguage.english",
  },
  {
    value: "zh-CN",
    labelKey: "options.general.interfaceLanguage.simplifiedChinese",
  },
]

export default function InterfaceLanguageSettings() {
  const uiLocale = useAtomValue(configFieldsAtomMap.uiLocale)
  const setConfig = useSetAtom(writeConfigAtom)
  const currentItem = UI_LOCALE_ITEMS.find(item => item.value === uiLocale) ?? UI_LOCALE_ITEMS[0]

  async function handleLocaleChange(value: string) {
    if (value === uiLocale) {
      return
    }

    await setConfig({ uiLocale: value as UILocale })
    window.location.reload()
  }

  return (
    <ConfigCard
      id="interface-language"
      title={i18n.t("options.general.interfaceLanguage.title")}
      description={i18n.t("options.general.interfaceLanguage.description")}
    >
      <div className="w-full flex justify-start md:justify-end">
        <Select
          value={uiLocale}
          onValueChange={(value) => {
            if (value !== null) {
              void handleLocaleChange(value)
            }
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue render={<span />}>
              <span className="flex items-center gap-2">
                <Icon icon="tabler:language" className="size-4" />
                {i18n.t(currentItem.labelKey)}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {UI_LOCALE_ITEMS.map(item => (
                <SelectItem key={item.value} value={item.value}>
                  <span className="flex items-center gap-2">
                    <Icon icon="tabler:language" className="size-4" />
                    {i18n.t(item.labelKey)}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </ConfigCard>
  )
}
