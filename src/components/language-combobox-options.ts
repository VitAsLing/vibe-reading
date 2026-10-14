import type { LangCodeISO6393 } from "@/definitions"

export interface LanguageItem<T extends LangCodeISO6393 | "auto" = LangCodeISO6393 | "auto"> {
  value: T
  label: string
  name?: string
}

export function filterLanguage(item: LanguageItem, query: string): boolean {
  const searchLower = query.toLowerCase()
  return item.label.toLowerCase().includes(searchLower)
    || (item.name?.toLowerCase().includes(searchLower) ?? false)
    || item.value.toLowerCase().includes(searchLower)
}
