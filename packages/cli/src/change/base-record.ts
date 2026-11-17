/**
 * A stored base record (RFC 0040 §3): the `record.json` a push run of the Change workflow wrote
 * for the merge base, read in place of rebuilding the base where the head's install does not
 * serve it. A record of another format, target or environment is not compared; a differing
 * `@guren/cli` or `@guren/server` version is named and does not stop the comparison.
 */
import { readFile } from 'node:fs/promises'

import { SECURITY_RECORD_VERSION, type SecurityRecords } from './security-records'

export interface BaseRecordExpectation {
  mergeBase: string
  recordVersion: number
  target: string
  environment: string | null
}

export interface StoredBase {
  records: SecurityRecords
  head: string
  cli: string | null
  server: string | null
}

/** `fix`: what would make the record comparable, where something would. */
export type BaseRecordReading = StoredBase | { unusable: string; fix?: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `value` holds a `SecurityRecords` this version compares, by shape alone. */
function isSecurityRecords(value: unknown): value is SecurityRecords {
  if (!isObject(value) || typeof value.recordVersion !== 'number' || !Array.isArray(value.routes)) return false
  return value.routes.every((route) => isObject(route) && typeof route.method === 'string' && typeof route.path === 'string' && Array.isArray(route.middleware) && isObject(route.contracts) && isObject(route.handler))
}

/** Reads a parsed `record.json` against what the head's run expects of a comparable base. */
export function readBaseRecord(value: unknown, expected: BaseRecordExpectation): BaseRecordReading {
  const fix = `run the Change workflow on ${expected.mergeBase.slice(0, 12)} again`
  const unusable = (why: string): BaseRecordReading => ({ unusable: why, fix })
  if (!isObject(value)) return unusable('the base record is not a record')
  if (value.recordVersion !== expected.recordVersion) return unusable(`the base record is format ${String(value.recordVersion)}, and this run writes ${expected.recordVersion}`)
  if (value.head !== expected.mergeBase) return { unusable: `the base record is of ${typeof value.head === 'string' ? value.head.slice(0, 12) : 'no commit'}, not of the merge base ${expected.mergeBase.slice(0, 12)}` }
  if (value.target !== expected.target) return unusable(`the base record was judged for the ${String(value.target)} target, and this run for ${expected.target}`)
  if ((value.environment ?? null) !== expected.environment) return unusable(`the base record was judged under NODE_ENV=${String(value.environment ?? 'unset')}, and this run under ${expected.environment ?? 'unset'}`)
  const records = value.securityRecords
  if (isObject(records) && 'unavailable' in records) return unusable(`the base record holds no security records (${String(records.unavailable)})`)
  if (!isSecurityRecords(records)) return unusable("the base record's security records are not in a shape this version reads")
  if (records.recordVersion !== SECURITY_RECORD_VERSION) return unusable(`the base record's security records are version ${records.recordVersion}, and this run reads ${SECURITY_RECORD_VERSION}`)
  return { records, head: value.head, cli: typeof value.cli === 'string' ? value.cli : null, server: typeof value.server === 'string' ? value.server : null }
}

/** Reads the `--base-record` file, or why it could not be read: a file that will not parse is unusable, never an error. */
export async function loadBaseRecord(path: string, expected: BaseRecordExpectation): Promise<BaseRecordReading> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return { unusable: `the base record ${path} could not be read (${(error as Error).message.split('\n')[0]})` }
  }
  return readBaseRecord(value, expected)
}
