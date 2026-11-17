import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadBaseRecord, readBaseRecord, type BaseRecordExpectation } from '../src/change/base-record'
import { SECURITY_RECORD_VERSION } from '../src/change/security-records'
import { createTempRoot } from './helpers'

const mergeBase = 'c'.repeat(40)
const expected: BaseRecordExpectation = { mergeBase, recordVersion: 3, target: 'default', environment: null }
const route = { method: 'GET', path: '/posts', module: null, action: 'PostController.index', middleware: [], contracts: {}, handler: { authenticates: false, authorizes: [], validates: [] } }
const record = (overrides: Record<string, unknown> = {}) => ({
  recordVersion: 3, cli: '2.37.3', server: '2.37.0', target: 'default', environment: null, head: mergeBase,
  securityRecords: { recordVersion: SECURITY_RECORD_VERSION, routes: [route] },
  ...overrides,
})

describe('readBaseRecord', () => {
  test('should read a record of the merge base, keeping the versions it was written by', () => {
    expect(readBaseRecord(record(), expected)).toEqual({ records: { recordVersion: SECURITY_RECORD_VERSION, routes: [route] }, head: mergeBase, cli: '2.37.3', server: '2.37.0' })
  })

  test('should compare a record written by another @guren/cli or @guren/server', () => {
    expect(readBaseRecord(record({ cli: '2.30.0', server: undefined }), expected)).toMatchObject({ cli: '2.30.0', server: null })
  })

  test('should refuse a record of another commit, with no fix to offer', () => {
    expect(readBaseRecord(record({ head: 'd'.repeat(40) }), expected)).toEqual({ unusable: `the base record is of ${'d'.repeat(12)}, not of the merge base ${'c'.repeat(12)}` })
  })

  test('should refuse what it would not compare, naming the run that would write a comparable one', () => {
    const fix = `run the Change workflow on ${'c'.repeat(12)} again`
    const cases: Array<[unknown, string]> = [
      [[], 'the base record is not a record'],
      [record({ recordVersion: 2 }), 'the base record is format 2, and this run writes 3'],
      [record({ target: 'cloudflare' }), 'the base record was judged for the cloudflare target, and this run for default'],
      [record({ environment: 'production' }), 'the base record was judged under NODE_ENV=production, and this run under unset'],
      [record({ securityRecords: { unavailable: 'no-audit' } }), 'the base record holds no security records (no-audit)'],
      [record({ securityRecords: { recordVersion: SECURITY_RECORD_VERSION, routes: [{ method: 'GET' }] } }), "the base record's security records are not in a shape this version reads"],
      [record({ securityRecords: { recordVersion: SECURITY_RECORD_VERSION + 1, routes: [] } }), `the base record's security records are version ${SECURITY_RECORD_VERSION + 1}, and this run reads ${SECURITY_RECORD_VERSION}`],
    ]
    for (const [value, why] of cases) expect(readBaseRecord(value, expected)).toEqual({ unusable: why, fix })
  })
})

describe('loadBaseRecord', () => {
  test('should read the file, and call one that is missing or not JSON unusable rather than throw', async () => {
    const dir = await createTempRoot('guren-base-record-')
    const good = join(dir, 'record.json')
    const broken = join(dir, 'broken.json')
    await writeFile(good, JSON.stringify(record()), 'utf8')
    await writeFile(broken, '{', 'utf8')

    expect(await loadBaseRecord(good, expected)).toMatchObject({ head: mergeBase })
    expect(await loadBaseRecord(broken, expected)).toEqual({ unusable: expect.stringContaining(`the base record ${broken} could not be read`) })
    expect(await loadBaseRecord(join(dir, 'missing.json'), expected)).toEqual({ unusable: expect.stringContaining('could not be read') })
  })
})
