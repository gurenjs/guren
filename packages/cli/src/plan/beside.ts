/**
 * What a plan keeps beside itself (RFC 0030 §9): its committed decision log and approvals,
 * and the page `plan:render` writes. `docs/plans/<slug>/plan.json` keeps the records as
 * `<record>.json` in its directory; a plan named for its slug keeps `<slug>.<record>.json`,
 * so two plans in one directory do not share one. Also the `git status` exclusions for those
 * files, and who `git config` says is acting, which both records name.
 */

import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { z } from 'zod'

import { formatSchemaIssues } from '../cli-error'
import { toPosixRelative } from '../discovery'
import type { CapturedExec } from '../subprocess'

export function planSiblingPath(planPath: string, record: 'decisions' | 'approvals'): string {
  const name = basename(planPath)
  if (name === 'plan.json') return join(dirname(planPath), `${record}.json`)
  return join(dirname(planPath), `${name.replace(/(\.plan)?\.json$/u, '')}.${record}.json`)
}

/** The page `plan:render` writes when no `--output` is given. */
export function planOutputPath(planPath: string): string {
  return planPath.endsWith('.json') ? `${planPath.slice(0, -'.json'.length)}.html` : `${planPath}.html`
}

/**
 * `git status` pathspecs excluding what the plan commands write beside a plan: its page and,
 * with `records`, the plan itself, its approvals and its decision log, plus a leftover
 * {@link writeFileAtomic} temporary of each. Only `plan:approve`, which writes the records,
 * may pass `records`: they are committed, and a waiver in the log steers `plan:next`.
 * Relative to `root`; both paths must be real, or a symlinked temp directory makes every one miss.
 */
export function planBesideExclusions(root: string, planPath: string, options: { records: boolean }): string[] {
  const own = [planOutputPath(planPath), ...(options.records ? [planPath, planSiblingPath(planPath, 'approvals'), planSiblingPath(planPath, 'decisions')] : [])]
  const inside = (file: string): string | undefined => {
    const relative = toPosixRelative(root, file)
    return relative.startsWith('../') ? undefined : relative
  }
  return own.flatMap((file) => {
    const relative = inside(file)
    if (relative === undefined) return []
    const temporary = inside(join(dirname(file), `.${basename(file)}.`))!
    return [`:(exclude,literal)${relative}`, `:(exclude,glob)${globEscape(temporary)}*.tmp`]
  })
}

function globEscape(path: string): string {
  return path.replace(/[*?[\]\\]/gu, (character) => `\\${character}`)
}

/** `git config` on a machine with no identity answers nothing, which the record simply omits. */
export async function gitAuthor(cwd: string, exec: CapturedExec): Promise<string | undefined> {
  const value = async (key: string): Promise<string | undefined> => {
    try {
      const run = await exec(['git', 'config', '--get', key], cwd)
      const text = run.stdout.trim()
      return run.exitCode === 0 && text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }
  const name = await value('user.name')
  const email = await value('user.email')
  if (name && email) return `${name} <${email}>`
  return name ?? email
}

export interface BesideRecordRead<T> {
  value: T | undefined
  /** Set when a file exists and would not read; `value` is then `undefined`. */
  unreadable?: string
}

/** Absent is `value: undefined` with no reason; a file that exists and does not parse says why. */
export async function readBesideRecord<T>(path: string, schema: z.ZodType<T>, what: string): Promise<BesideRecordRead<T>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: undefined }
    return { value: undefined, unreadable: `${path} could not be read: ${(error as Error).message}` }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return { value: undefined, unreadable: `${path} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = schema.safeParse(document)
  if (!parsed.success) return { value: undefined, unreadable: `${path} does not match the ${what} schema:\n${formatSchemaIssues(parsed.error)}` }
  return { value: parsed.data }
}

/**
 * Through a hidden temporary file beside the target, so a reader never sees half a record.
 * A symlinked target is written through to the file it names, and an existing file keeps its mode.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  let target = path
  let mode: number | undefined
  try {
    target = await realpath(path)
    mode = (await stat(target)).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, content, 'utf8')
    if (mode !== undefined) await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
