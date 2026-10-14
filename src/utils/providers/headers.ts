export function getProviderHeaders(record?: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  if (!record) {
    return undefined
  }

  const compacted = Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => {
      const [, value] = entry
      return typeof value === "string" && value !== ""
    }),
  )

  return Object.keys(compacted).length > 0 ? compacted : undefined
}
