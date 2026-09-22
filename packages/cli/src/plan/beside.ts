/**
 * The committed records a plan keeps beside itself (RFC 0030 §9): its decision log and its
 * approvals. `docs/plans/<slug>/plan.json` keeps them as `<record>.json` in its directory;
 * a plan named for its slug keeps `<slug>.<record>.json`, so two plans in one directory do
 * not share one. Also who `git config` says is acting, which both records name.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { z } from 'zod'

import { formatSchemaIssues } from '../cli-error'
import type { CapturedExec } from '../subprocess'

export function planSiblingPath(planPath: string, record: 'decisions' | 'approvals'): string {
  const name = basename(planPath)
  if (name === 'plan.json') return join(dirname(planPath), `${record}.json`)
  return join(dirname(planPath), `${name.replace(/(\.plan)?\.json$/u, '')}.${record}.json`)
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

/** Through a temporary file in the same directory, so a reader never sees half a record. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
