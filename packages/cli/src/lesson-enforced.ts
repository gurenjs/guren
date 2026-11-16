/**
 * A lesson's `enforcedBy: <file>#<name>` (RFC 0040 §11): the one reading `check --docs` judges it
 * by and `make:lesson --enforced-by` refuses on, so the two cannot disagree on what names a check.
 */
import { posix } from 'node:path'

export interface EnforcedBy {
  /** As written. */
  file: string
  /** `file` normalized, relative to the application root: what is read. */
  path: string
  /** Everything after the first `#`, so `#AC-auth-1#removed` is not read as `AC-auth-1`. */
  name: string | undefined
}

export function parseEnforcedBy(value: string): EnforcedBy {
  const separator = value.indexOf('#')
  const file = separator === -1 ? value : value.slice(0, separator)
  return {
    file,
    path: posix.normalize(file),
    name: separator === -1 ? undefined : value.slice(separator + 1),
  }
}

/** Whether `text` holds `name` as a whole token: `AC-posts-1` must not pass on `AC-posts-12`, nor `no-drizzle` on `controllers-no-drizzle`. */
export function holdsName(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`, 'u').test(text)
}

/**
 * Why `value` names no check that exists, or `undefined` when it does. `read` returns the file's
 * text, or `undefined` for a path outside the application or a file that is not there.
 */
export async function enforcedByProblem(value: string, read: (file: string) => Promise<string | undefined>): Promise<string | undefined> {
  if (value.trim() === '') return '`enforcedBy:` is present but names nothing (empty, or not a single value), so no check is followed.'
  const { file, path, name } = parseEnforcedBy(value)
  if (!name) return `\`enforcedBy: ${value}\` names no check in ${file}: a file existing is not a check that catches the failure.`
  const text = await read(path)
  if (text === undefined) return `\`enforcedBy: ${value}\` names ${file}, which is not a file in the application.`
  if (!holdsName(text, name)) return `\`enforcedBy: ${value}\`: ${file} does not hold ${name}.`
  return undefined
}
