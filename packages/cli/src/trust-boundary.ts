/**
 * The trust boundary of RFC 0039 §9, pure: what a `deps:exposure` or audit run's
 * results rest on without checking. Every entry comes from an input the run
 * produced (a coverage reason, a count, a fix), so a check the run did not make
 * is said to be missing, never claimed. `deps:exposure` and `guren audit` both
 * build their section here.
 */
import type { GraphCoverage } from './application-graph'
import type { RuntimeCheck } from './bun-runtime'
import type { ExposureCoverageKey } from './dependency-exposure'
import type { DependencyFix } from './dependency-fix'

/** The reader or step an entry is about, in the order the section lists them. */
export type TrustBoundarySource = 'runtime' | 'exposure' | 'framework' | 'tree' | 'imports' | 'placement' | 'graph' | 'snapshot' | 'response' | 'fix' | 'lockfile'

export interface TrustBoundaryEntry {
  from: TrustBoundarySource
  message: string
  file?: string
  line?: number
}

export interface ExposureBoundaryInput {
  coverage: Pick<Record<ExposureCoverageKey, GraphCoverage>, 'tree' | 'imports' | 'placement' | 'graph'>
  consistency: 'stable' | 'changed'
  lockfile: string | null
  /** Installed instances attributed to no route because only @guren packages bring them in. */
  framework: number
  /** Installed instances whose routes a reader lost track of. */
  unknown: number
  /** Lockfile entries carrying no integrity hash (workspace, `file:` and `link:` packages). */
  unhashed: number
}

const ORDER: readonly TrustBoundarySource[] = ['runtime', 'exposure', 'framework', 'tree', 'imports', 'placement', 'graph', 'snapshot', 'response', 'fix', 'lockfile']

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function fromReason(from: TrustBoundarySource, reason: GraphCoverage['reasons'][number]): TrustBoundaryEntry {
  return { from, message: reason.message, ...(reason.file ? { file: reason.file } : {}) }
}

/** `undefined` is a run that did not check the runtime: the section says so rather than naming a source it never read. */
export function runtimeBoundary(check: Pick<RuntimeCheck, 'coverage'> | undefined): TrustBoundaryEntry[] {
  if (!check) return [{ from: 'runtime', message: 'The Bun runtime was not checked against its advisories in this run.' }]
  const { coverage } = check
  if (coverage.status === 'unavailable') {
    return [{ from: 'runtime', message: `The Bun runtime was not checked: ${coverage.reasons.map((reason) => reason.message).join(' ')}` }]
  }
  return [
    { from: 'runtime', message: "Bun's own advisories are read from oven-sh/bun's repository advisories only; one published only in another database is not seen." },
    ...coverage.reasons.map((reason) => fromReason('runtime', reason)),
  ]
}

export function exposureBoundary(input: ExposureBoundaryInput): TrustBoundaryEntry[] {
  const entries: TrustBoundaryEntry[] = []
  if (input.framework > 0) {
    entries.push({ from: 'framework', message: `${plural(input.framework, 'installed package is', 'installed packages are')} brought in only by @guren packages and attributed to no route; every route runs through the framework.` })
  }
  if (input.unknown > 0) {
    entries.push({ from: 'graph', message: `${plural(input.unknown, 'installed package is', 'installed packages are')} attributed to no route because a reader below lost track of the path.` })
  }
  for (const key of ['tree', 'imports', 'placement', 'graph'] as const) {
    const coverage = input.coverage[key]
    if (coverage.status !== 'complete') entries.push(...coverage.reasons.map((reason) => fromReason(key, reason)))
  }
  if (input.consistency === 'changed') {
    entries.push({ from: 'snapshot', message: 'Files changed while they were read, so the results may mix two states of the app.' })
  }
  if (input.lockfile !== null) {
    const unhashed = input.unhashed > 0 ? ` ${plural(input.unhashed, 'entry carries', 'entries carry')} no hash (workspace, file: or link: packages).` : ''
    entries.push({ from: 'lockfile', message: `Bun checks the integrity hashes in ${input.lockfile} at install; Guren reads the lockfile as written.${unhashed}` })
  }
  return entries
}

export function responseBoundary(unread: ReadonlyArray<{ file: string; line: number; where: string; expression?: string; reason: string }>): TrustBoundaryEntry[] {
  return unread.map((entry) => ({
    from: 'response',
    message: `${entry.where}${entry.expression ? ` ${entry.expression}` : ''}: ${entry.reason}, so it is not judged safe.`,
    file: entry.file,
    line: entry.line,
  }))
}

/** `proposed: false` is a run that found advisories and was told not to look for fixes. */
export function fixBoundary(advisories: ReadonlyArray<{ package: string; ghsa: string; fix?: DependencyFix }>, proposed: boolean): TrustBoundaryEntry[] {
  if (advisories.length === 0) return []
  if (!proposed) return [{ from: 'fix', message: 'No fix was proposed for the advisories (--no-fix).' }]
  return advisories.flatMap(({ package: name, ghsa, fix }) => fix?.status === 'candidate'
    ? [{ from: 'fix' as const, message: `${name} (${ghsa}): the fix is a candidate, not resolved by Bun: ${fix.reason ?? 'the resolution check did not run'}` }]
    : [])
}

export function orderTrustBoundary(entries: readonly TrustBoundaryEntry[]): TrustBoundaryEntry[] {
  return [...entries].sort((a, b) => ORDER.indexOf(a.from) - ORDER.indexOf(b.from))
}

/** The section as text lines; `limit` caps the entries shown per source, naming how many more the JSON holds. */
export function renderTrustBoundary(entries: readonly TrustBoundaryEntry[], limit = Number.POSITIVE_INFINITY): string[] {
  if (entries.length === 0) return []
  const lines = ['What these results rest on without checking:']
  for (const from of ORDER) {
    const group = entries.filter((entry) => entry.from === from)
    for (const entry of group.slice(0, limit)) {
      // Most coverage reasons already open with the file they name.
      const at = entry.file && !entry.message.startsWith(entry.file) ? `${entry.file}${entry.line !== undefined ? `:${entry.line}` : ''} ` : ''
      lines.push(`  ${from}: ${at}${entry.message}`)
    }
    if (group.length > limit) lines.push(`  ${from}: and ${group.length - limit} more (--json lists them under trustBoundary)`)
  }
  return lines
}
