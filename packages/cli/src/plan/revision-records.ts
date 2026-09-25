/**
 * A plan's revision records (RFC 0030 §4, §9): one `{ parent, ops, result }` per `plan:revise`,
 * numbered in the order they were written, in the directory `planRevisionsDir()` names. They are
 * committed beside the plan, and each is exactly `PlanRevisionSchema`, so `applyRevision()` reads
 * one back. A record is never rewritten: a second writer of the same number is refused.
 * The records are not a verified chain: a record whose result the plan never reached (the plan
 * write after it failed) stays where it is, and the next run records again from the same parent.
 */

import { link, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CliError } from '../cli-error'
import { planRevisionsDir, readBesideRecord, temporaryBeside } from './beside'
import { PlanRevisionSchema, type PlanRevision } from './revision'

const RECORD_NAME = /^(\d+)\.json$/u

/** Wide enough that a plan's records sort by name as they sort by number. */
const RECORD_DIGITS = 4

export interface PlanRevisionRecord {
  path: string
  sequence: number
  revision: PlanRevision
}

export interface PlanRevisionRecordsRead {
  records: PlanRevisionRecord[]
  /** Files, or the directory, that exist and would not read, each with why. */
  unreadable: string[]
}

async function recordNames(dir: string): Promise<{ names: string[]; unreadable?: string }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return { names: entries.filter((entry) => entry.isFile() && RECORD_NAME.test(entry.name)).map((entry) => entry.name) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { names: [] }
    return { names: [], unreadable: `${dir} could not be listed: ${(error as Error).message}` }
  }
}

function sequenceOf(name: string): number {
  return Number(RECORD_NAME.exec(name)![1])
}

export async function readPlanRevisionRecords(planPath: string): Promise<PlanRevisionRecordsRead> {
  const dir = planRevisionsDir(planPath)
  const listed = await recordNames(dir)
  const read: PlanRevisionRecordsRead = { records: [], unreadable: listed.unreadable ? [listed.unreadable] : [] }
  for (const name of listed.names) {
    const path = join(dir, name)
    const record = await readBesideRecord(path, PlanRevisionSchema, 'plan revision')
    if (record.unreadable) read.unreadable.push(record.unreadable)
    else if (record.value) read.records.push({ path, sequence: sequenceOf(name), revision: record.value })
  }
  read.records.sort((a, b) => a.sequence - b.sequence)
  return read
}

/**
 * Writes `revision` as the next number after every record name present, readable or not, and
 * returns its path. The file appears whole or not at all: it is written to a temporary and
 * linked into place, and `link()` refuses a name that exists where `rename()` would replace it.
 */
export async function writePlanRevisionRecord(planPath: string, revision: PlanRevision): Promise<string> {
  const dir = planRevisionsDir(planPath)
  await mkdir(dir, { recursive: true })
  const listed = await recordNames(dir)
  if (listed.unreadable) throw new CliError(`${listed.unreadable}\nThe revision is not recorded, so the plan was left as it was.`)
  const next = Math.max(0, ...listed.names.map(sequenceOf)) + 1
  const path = join(dir, `${String(next).padStart(RECORD_DIGITS, '0')}.json`)
  const temporary = temporaryBeside(path)
  try {
    try {
      await writeFile(temporary, `${JSON.stringify(revision, null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new CliError(`The revision could not be written to ${temporary} (${(error as Error).message}), so it is not recorded and the plan was left as it was.`)
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliError(`${path} appeared while this revision was being written, so it is not recorded and the plan was left as it was. Run the command again.`)
      }
      throw new CliError(
        `The revision could not be linked into place as ${path} (${(error as Error).message}), so the plan was left as it was. The record is linked into place, which needs a filesystem that supports hard links.`,
      )
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return path
}
