export interface ParseImportMapOptions {
  /** Label used in the parse-failure warning. */
  context?: string
}

/**
 * Empty, null and undefined entries are dropped, so callers can merge optional
 * overrides without filtering first.
 */
export function parseImportMap(
  value: string | undefined,
  options: ParseImportMapOptions = {},
): Record<string, string> {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as Record<string, string | null | undefined>
    const result: Record<string, string> = {}

    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === 'string' && entry.length > 0) {
        result[key] = entry
      }
    }

    return result
  } catch (error) {
    const label = options.context ?? 'import map'
    console.warn(`Failed to parse ${label}. Expected JSON object.`, error)
    return {}
  }
}
