import type { UILocale } from "@/types/config/config"
import { browser, i18n as browserI18n } from "#imports"

interface ChromeMessage {
  message: string
}

type ChromeMessages = Record<string, ChromeMessage>

const LOCALE_DIRECTORY: Record<UILocale, string> = {
  "en": "en",
  "zh-CN": "zh_CN",
}

let selectedMessages: ChromeMessages | null = null

function getMessageId(key: string) {
  return key.replaceAll(".", "_")
}

function resolveSubstitutions(args: unknown[]) {
  let count: number | undefined
  let substitutions: string[] | undefined

  for (const arg of args) {
    if (arg == null) {
      continue
    }
    if (typeof arg === "number") {
      count = arg
      continue
    }
    if (Array.isArray(arg)) {
      substitutions = arg.map(String)
      continue
    }

    throw new Error("Invalid i18n argument. Use a number for pluralization or an array for substitutions.")
  }

  if (count !== undefined && substitutions === undefined) {
    substitutions = [String(count)]
  }

  return { count, substitutions }
}

function applySubstitutions(message: string, substitutions?: string[]) {
  if (!substitutions?.length) {
    return message
  }

  return message.replace(/\$(\d+)/g, (match, index) => {
    const value = substitutions[Number(index) - 1]
    return value ?? match
  })
}

function applyPlural(message: string, count?: number) {
  if (count === undefined) {
    return message
  }

  const plural = message.split(" | ")
  switch (plural.length) {
    case 1:
      return plural[0] ?? ""
    case 2:
      return plural[count === 1 ? 0 : 1] ?? ""
    case 3:
      return plural[count === 0 || count === 1 ? count : 2] ?? ""
    default:
      throw new Error(`Unknown plural formatting: ${message}`)
  }
}

export async function loadUiLocaleMessages(locale: UILocale, options?: { applyDocumentLang?: boolean }) {
  const directory = LOCALE_DIRECTORY[locale]
  const getRuntimeUrl = browser.runtime.getURL as (path: string) => string
  const response = await fetch(getRuntimeUrl(`_locales/${directory}/messages.json`))
  if (!response.ok) {
    throw new Error(`Failed to load UI locale messages for ${locale}`)
  }

  selectedMessages = await response.json() as ChromeMessages
  if (options?.applyDocumentLang ?? true) {
    document.documentElement.lang = locale
  }
}

export const i18n = {
  ...browserI18n,
  t: ((key: string, ...args: unknown[]) => {
    if (!selectedMessages) {
      return browserI18n.t(key as never, ...(args as []))
    }

    const message = selectedMessages[getMessageId(key)]?.message
    if (!message) {
      console.warn(`[i18n] Message not found: "${key}"`)
      return key
    }

    const { count, substitutions } = resolveSubstitutions(args)
    return applyPlural(applySubstitutions(message, substitutions), count)
  }) as typeof browserI18n.t,
}
