/**
 * The one rule for what a daily-rotated log file is called:
 * `dir/name-YYYY-MM-DD.ext`. {@link DailyFileChannel} names what it appends to
 * through this module, and the audit reader behind `guren tool:log` decides
 * what to read through the same one; a second copy drifts silently, leaving an
 * empty audit trail rather than an error. Naming only — nothing here touches
 * the filesystem, so a caller keeps "missing" and "unreadable" apart itself.
 */
import * as path from 'node:path'

/**
 * The `YYYY-MM-DD` stamp a file rotated at `date` carries. UTC, because the
 * rotation boundary must be the same instant for every process appending to one
 * directory — a fleet across time zones would write two files for one day.
 */
export function dailyFileDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The dated file a base path rotates to on `date`. */
export function dailyFilePath(basePath: string, date: Date): string {
  const { dir, name, ext } = path.parse(basePath)
  return path.join(dir, `${name}-${dailyFileDateStamp(date)}${ext}`)
}

/**
 * The date stamp of `fileName` if it is one of `basePath`'s dated files, else
 * `null` — the inverse of {@link dailyFilePath}. The base name and extension
 * are escaped first: `app.v1.log` would otherwise match another app's files
 * into this rotation set, which for the cleanup consuming it means deleting them.
 */
export function matchDailyFileDate(basePath: string, fileName: string): string | null {
  const { name, ext } = path.parse(basePath)
  const pattern = new RegExp(`^${escapeRegExp(name)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(ext)}$`, 'u')
  return pattern.exec(fileName)?.[1] ?? null
}

/** Every character with meaning inside a regular expression, made literal. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
