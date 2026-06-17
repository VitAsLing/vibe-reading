import type { LangCodeISO6393 } from "@/definitions"
import { camelCase } from "case-anything"
import { LANG_CODE_TO_LOCALE_NAME } from "@/definitions"
import { i18n } from "@/utils/i18n"

export function getLanguageName(code: LangCodeISO6393) {
  return i18n.t(`languages.${camelCase(code)}` as Parameters<typeof i18n.t>[0])
}

export function getLanguageLabel(code: LangCodeISO6393) {
  return `${getLanguageName(code)} (${LANG_CODE_TO_LOCALE_NAME[code]})`
}
