import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DailyFileChannel } from './channels/DailyFileChannel'
import { dailyFileDateStamp, dailyFilePath, matchDailyFileDate } from './daily-file-path'

/** Future-seeded: see `agent/audit.test.ts` for why a past epoch is a trap. */
const NOW = new Date('2087-03-14T01:59:26.535Z')

describe('dailyFilePath', () => {
  test('should name the file the way DailyFileChannel always has', () => {
    // The format itself, pinned. The channel wrote `dir/name-YYYY-MM-DD.ext`
    // before this rule was extracted out of it, and every file already on an
    // operator's disk carries that spelling — a reader derived from a changed
    // rule would stop seeing them.
    expect(dailyFilePath('/var/log/app.log', NOW)).toBe('/var/log/app-2087-03-14.log')
    expect(dailyFilePath('./storage/logs/agent-audit.log', NOW)).toBe('storage/logs/agent-audit-2087-03-14.log')
    expect(dailyFilePath('agent-audit.log', NOW)).toBe('agent-audit-2087-03-14.log')
  })

  test('should stamp in UTC so processes in different zones agree', () => {
    // Late enough in the UTC day that any westward zone would call it the 13th.
    expect(dailyFileDateStamp(new Date('2087-03-14T23:59:59.999Z'))).toBe('2087-03-14')
  })

  test('should keep a path with no extension usable', () => {
    expect(dailyFilePath('/var/log/audit', NOW)).toBe('/var/log/audit-2087-03-14')
  })
})

describe('matchDailyFileDate', () => {
  test('should recover the stamp of a file the writer named', () => {
    const basePath = '/var/log/app.log'

    expect(matchDailyFileDate(basePath, 'app-2087-03-14.log')).toBe('2087-03-14')
    expect(matchDailyFileDate(basePath, 'app.log')).toBeNull()
    expect(matchDailyFileDate(basePath, 'app-2087-03.log')).toBeNull()
    expect(matchDailyFileDate(basePath, 'other-2087-03-14.log')).toBeNull()
    expect(matchDailyFileDate(basePath, 'app-2087-03-14.log.gz')).toBeNull()
  })

  test('should treat a base path with regex metacharacters literally', () => {
    // Unescaped, `app.v1`'s dot matches any character, so `appXv1-…` would be
    // read as one of this base path's files — and the retention sweep that
    // consumes this match deletes what it matches.
    expect(matchDailyFileDate('/var/log/app.v1.log', 'app.v1-2087-03-14.log')).toBe('2087-03-14')
    expect(matchDailyFileDate('/var/log/app.v1.log', 'appXv1-2087-03-14.log')).toBeNull()
  })

  test('should be the exact inverse of dailyFilePath', () => {
    const basePath = '/var/log/agent-audit.log'
    const written = dailyFilePath(basePath, NOW)

    expect(matchDailyFileDate(basePath, written.slice(written.lastIndexOf('/') + 1))).toBe(dailyFileDateStamp(NOW))
  })
})

describe('DailyFileChannel through the extracted rule', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'guren-daily-'))
    dirs.push(dir)
    return dir
  }

  test('should write to the path the shared rule names', () => {
    const dir = tempDir()
    const basePath = join(dir, 'app.log')
    const channel = new DailyFileChannel({ driver: 'daily', path: basePath, level: 'debug' })

    channel.log({ level: 'info', message: 'hello', context: {}, timestamp: NOW })

    expect(readdirSync(dir)).toEqual(['app-2087-03-14.log'])
    expect(dailyFilePath(basePath, NOW)).toBe(join(dir, 'app-2087-03-14.log'))
  })

  test('should sweep only its own expired files', () => {
    const dir = tempDir()
    const basePath = join(dir, 'app.log')
    writeFileSync(join(dir, 'app-2020-01-01.log'), 'expired\n')
    writeFileSync(join(dir, 'other-2020-01-01.log'), 'not ours\n')
    writeFileSync(join(dir, 'app-2020-01-01.log.bak'), 'not ours either\n')

    const channel = new DailyFileChannel({ driver: 'daily', path: basePath, days: 14, level: 'debug' })
    channel.log({ level: 'info', message: 'hello', context: {}, timestamp: new Date() })

    const remaining = readdirSync(dir).sort()
    expect(remaining).not.toContain('app-2020-01-01.log')
    expect(remaining).toContain('other-2020-01-01.log')
    expect(remaining).toContain('app-2020-01-01.log.bak')
  })
})
