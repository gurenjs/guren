export interface ParseImportMapOptions {
  /**
   * Optional label describing the source of the import map.
   * Used in warning logs when parsing fails.
   */
  context?: string
}

/**
 * Parses an import map JSON string into a record of module specifiers.
 * Empty, null, and undefined entries are ignored so callers can safely
 * merge optional overrides without additional filtering.
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
