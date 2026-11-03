/**
 * `guren audit --deps-baseline <file>` (RFC 0039 §5): a scheduled run fails on an
 * advisory the baseline does not name, and on a dependency scan that did not
 * complete, so a registry outage never reads as "nothing new". An advisory the
 * app ignores in config/audit.ts is accepted already and never new.
 */
import { consola } from 'consola'
import type { AuditReport } from './audit'

export interface DepsBaselineResult {
  file: string
  /** Advisory finding keys the baseline does not name, in report order. */
  newKeys: string[]
  /** Why the run fails without naming a key: the baseline or the scan could not be read. */
  failure?: string
}

/** A previous `guren audit --json` report, or a plain array of finding keys. */
export function readBaselineKeys(text: string): Set<string> | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'it is not JSON'
  }
  const keys = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: Array<{ key?: unknown }> }).findings.map((entry) => entry?.key)
      : null
  if (keys === null || !keys.every((key): key is string => typeof key === 'string')) {
    return 'it is neither a guren audit --json report nor an array of finding keys'
  }
  return new Set(keys)
}

export function judgeDepsBaseline(report: AuditReport, file: string, text: string | null): DepsBaselineResult {
  if (text === null) return { file, newKeys: [], failure: `The baseline ${file} could not be read.` }
  const baseline = readBaselineKeys(text)
  if (typeof baseline === 'string') return { file, newKeys: [], failure: `The baseline ${file} could not be used: ${baseline}.` }
  if (report.dependencyScan?.status !== 'complete') {
    return { file, newKeys: [], failure: `The dependency scan is ${report.dependencyScan?.status ?? 'missing'}, so the baseline cannot tell what is new.` }
  }
  const newKeys = report.findings
    .filter((finding) => finding.advisory !== undefined && finding.status !== 'ignored' && !baseline.has(finding.key))
    .map((finding) => finding.key)
  return { file, newKeys }
}

export function depsBaselineFails(result: DepsBaselineResult): boolean {
  return result.failure !== undefined || result.newKeys.length > 0
}

export function renderDepsBaseline(result: DepsBaselineResult): void {
  if (result.failure) {
    consola.error(result.failure)
    return
  }
  if (result.newKeys.length === 0) {
    consola.success(`No dependency advisory beyond ${result.file}.`)
    return
  }
  consola.error(`${result.newKeys.length} dependency ${result.newKeys.length === 1 ? 'advisory is' : 'advisories are'} not in ${result.file}: ${result.newKeys.join(', ')}`)
}
