import type { Config } from "@/types/config/config"
import { deepmergeCustom } from "deepmerge-ts"
import { dequal } from "dequal"

export const mergeWithArrayOverwrite = deepmergeCustom({
  mergeArrays: values => values[values.length - 1],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function changedFields(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(next).flatMap(([key, value]) => {
    const before = previous[key]
    if (dequal(before, value))
      return []
    return [[key, isRecord(before) && isRecord(value) ? changedFields(before, value) : value]]
  }))
}

// Editors sometimes submit an entire settings section. Only its edited fields
// belong to this write; unchanged siblings must not overwrite another page.
export function getChangedConfigFields(previous: Config, next: Config): Partial<Config> {
  return changedFields(previous, next) as Partial<Config>
}
