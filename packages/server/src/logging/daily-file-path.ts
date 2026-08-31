/**
 * The one rule for what a daily-rotated log file is called: `dir/name-YYYY-MM-DD.ext`.
 *
 * {@link DailyFileChannel} names the file it appends to through this module,
 * and the agent audit reader behind `guren tool:log` decides which files to
 * read through the same one. A second copy of the rule is how a writer and a
 * reader drift apart, and the drift is silent in the worst direction: the
 * writer keeps appending, the reader stops recognising, and what the operator
 * sees is an empty audit trail rather than an error.
 *
 * Naming only — nothing here touches the filesystem. The reader has to tell
 * "this directory does not exist" apart from "this directory could not be
 * read", and a helper that swallowed the difference on its behalf would put
 * that distinction back out of reach.
 */
import * as path from 'node:path'

/**
 * The `YYYY-MM-DD` stamp a file rotated at `date` carries.
 *
 * UTC, from the ISO form, because the rotation boundary has to be the same
 * instant for every process appending to the same directory — a fleet split
 * across time zones would otherwise write two different files for one day and
 * roll over at as many moments as it has zones.
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
 * The date stamp of `fileName` if it is one of `basePath`'s dated files, and
 * `null` if it is anything else in the same directory.
 *
 * The inverse of {@link dailyFilePath}, and the reason a caller listing a
 * directory does not need to know the shape it is matching. The base path's
 * own name and extension are escaped before they enter the pattern: a log
 * called `app.v1.log` parses to the name `app.v1`, whose dots would otherwise
 * match any character and let a *different* app's files into another's
 * rotation set — which, for the cleanup that consumes this, means deleting
 * them.
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
