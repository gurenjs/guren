import { describe, expect, it } from 'bun:test'
import type { AuditFinding, AuditReport } from '../src/audit'
import { depsBaselineFails, judgeDepsBaseline, readBaselineKeys } from '../src/audit-deps-baseline'

const advisory = (key: string, status: AuditFinding['status'] = 'fail'): AuditFinding => ({
  key,
  title: 'dependency',
  status,
  message: 'advisory',
  advisory: { package: key.split(':')[1]!, ghsa: key.split(':')[2]!, ranges: ['<1.0.0'] },
})

function report(findings: AuditFinding[], status: 'complete' | 'unavailable' | 'skipped' = 'complete'): AuditReport {
  return { findings, dependencyScan: { status, tool: 'bun audit' } } as AuditReport
}

describe('readBaselineKeys', () => {
  it('reads a previous audit report or a plain array of keys', () => {
    expect(readBaselineKeys(JSON.stringify({ findings: [{ key: 'deps:a:GHSA-1' }] }))).toEqual(new Set(['deps:a:GHSA-1']))
    expect(readBaselineKeys(JSON.stringify(['deps:a:GHSA-1']))).toEqual(new Set(['deps:a:GHSA-1']))
  })

  it('refuses anything else instead of reading it as an empty baseline', () => {
    expect(readBaselineKeys('not json')).toBe('it is not JSON')
    expect(typeof readBaselineKeys(JSON.stringify({ keys: ['deps:a:GHSA-1'] }))).toBe('string')
    expect(typeof readBaselineKeys(JSON.stringify([1]))).toBe('string')
  })
})

describe('judgeDepsBaseline', () => {
  it('names the advisories the baseline does not, skipping ignored ones and non-advisory deps findings', () => {
    const current = report([
      advisory('deps:a:GHSA-1'),
      advisory('deps:b:GHSA-2', 'warn'),
      advisory('deps:c:GHSA-3', 'ignored'),
      { key: 'deps:none', title: 'Dependency scan', status: 'pass', message: 'ok' },
    ])

    const result = judgeDepsBaseline(current, 'baseline.json', JSON.stringify(['deps:a:GHSA-1']))

    expect(result).toEqual({ file: 'baseline.json', newKeys: ['deps:b:GHSA-2'] })
    expect(depsBaselineFails(result)).toBe(true)
    expect(depsBaselineFails(judgeDepsBaseline(current, 'baseline.json', JSON.stringify(['deps:a:GHSA-1', 'deps:b:GHSA-2'])))).toBe(false)
  })

  it('fails on a scan that did not complete, so an outage never reads as nothing new', () => {
    const result = judgeDepsBaseline(report([], 'unavailable'), 'baseline.json', '[]')

    expect(result.failure).toBe('The dependency scan is unavailable, so the baseline cannot tell what is new.')
    expect(depsBaselineFails(result)).toBe(true)
  })

  it('counts a Bun runtime advisory as new, and fails when the runtime check is unavailable', () => {
    const runtime: AuditFinding = {
      key: 'deps:runtime:GHSA-9',
      title: 'Bun runtime',
      status: 'fail',
      message: 'advisory',
      runtime: { ghsa: 'GHSA-9', ranges: ['< 1.4.4'], patched: ['1.4.4'], versions: [] },
    }
    expect(judgeDepsBaseline(report([runtime]), 'baseline.json', '[]').newKeys).toEqual(['deps:runtime:GHSA-9'])

    const unavailable = {
      ...report([]),
      runtimeCheck: { coverage: { status: 'unavailable', reasons: [{ code: 'advisories-unavailable', message: 'api.github.com answered 500.' }] }, versions: [] },
    } as AuditReport
    expect(judgeDepsBaseline(unavailable, 'baseline.json', '[]').failure).toBe('The Bun runtime check is unavailable, so the baseline cannot tell what is new: api.github.com answered 500.')
  })

  it('fails on a baseline it could not read', () => {
    expect(judgeDepsBaseline(report([]), 'missing.json', null).failure).toBe('The baseline missing.json could not be read.')
    expect(judgeDepsBaseline(report([]), 'bad.json', '{').failure).toBe('The baseline bad.json could not be used: it is not JSON.')
  })
})
