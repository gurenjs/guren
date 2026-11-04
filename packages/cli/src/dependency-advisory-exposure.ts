/**
 * Advisory findings joined to the exposure document (RFC 0039 §5): each `deps:*`
 * finding carries every installed instance inside any of its ranges, and the
 * report carries the document's snapshot and coverage once. An advisory with no
 * instance in range says why, so an empty list never reads as "not exposed".
 */
import type { AuditFinding } from './audit'
import type { DependencyExposure } from './dependency-exposure-load'
import type { GraphCoverage } from './application-graph'

export type DependencyExposureSummary =
  | {
    snapshot: DependencyExposure['snapshot']
    coverage: DependencyExposure['coverage']
    /** The document's §9 entries but the runtime's, which the audit builds from its own check. */
    trustBoundary: DependencyExposure['trustBoundary']
  }
  | { error: { code: 'collection-failed'; message: string } }

/**
 * Bun places no prerelease inside a plain range (`1.2.0-beta.1` does not satisfy
 * `<1.2.0`, measured on 1.4.4), so a prerelease counts as in range, and so does a
 * range Bun cannot read, which `satisfies` reads as holding every version.
 */
export function inRange(version: string, ranges: readonly string[]): boolean {
  if (version.includes('-')) return true
  return ranges.some((range) => {
    try {
      return Bun.semver.satisfies(version, range)
    } catch {
      return true
    }
  })
}

export function attachExposures(findings: AuditFinding[], exposure: DependencyExposure): DependencyExposureSummary {
  const tree: GraphCoverage = exposure.coverage.tree
  for (const finding of findings) {
    if (!finding.advisory) continue
    const { package: name, ranges } = finding.advisory
    finding.exposures = exposure.packages.filter((instance) => instance.name === name && inRange(instance.version, ranges))
    if (finding.exposures.length > 0) continue
    const lockfile = exposure.lockfile ?? 'the lockfile'
    finding.exposureReason = tree.status !== 'complete'
      ? `The lockfile tree is ${tree.status}, so an instance of ${name} inside the advisory's ranges may be missing from it.`
      : exposure.workspace !== ''
        ? `No instance of ${name} this app installs is inside ${ranges.join(' || ')}. bun audit reads every workspace of ${lockfile}, so another workspace may hold it; if none does, treat it as exposed.`
        : `bun audit reports ${name}, but no instance in ${lockfile} is inside ${ranges.join(' || ')}; the two readers disagree, so treat it as exposed.`
  }
  return { snapshot: exposure.snapshot, coverage: exposure.coverage, trustBoundary: exposure.trustBoundary.filter((entry) => entry.from !== 'runtime') }
}

export function exposureUnavailable(findings: AuditFinding[], error: unknown): DependencyExposureSummary {
  const message = `Dependency exposure could not be collected (${error instanceof Error ? error.message : String(error)}).`
  for (const finding of findings) {
    if (finding.advisory) finding.exposureReason = message
  }
  return { error: { code: 'collection-failed', message } }
}
