import type { AuditFinding } from './audit'

/**
 * Dependency vulnerability scan for `guren audit` (RFC 0007): runs
 * `bun audit --json` in the app and converts advisories into findings.
 *
 * Exit 0 (clean) or 1 (advisories) carry valid JSON; any other code is an
 * execution/registry failure. The shape is validated, not assumed, and "could
 * not scan" is its own status, never a pass. Keep in step with
 * scripts/smoke/dependency-audit.ts, which reads the same output shape.
 */

export interface DependencyScan {
  status: 'complete' | 'unavailable' | 'skipped'
  tool: 'bun audit'
}

interface BunAuditAdvisory {
  url: string
  title: string
  severity: string
  vulnerable_versions: string
}

const GHSA_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i
const BAD_SHAPE = 'unrecognized bun audit output shape'

function scanFailure(findings: AuditFinding[], why: string, detail?: string): DependencyScan {
  findings.push({
    key: 'deps:scan',
    title: 'Dependency scan',
    status: 'warn',
    message: `Dependencies could not be scanned (${why}).${detail ? ` ${detail}` : ''}`,
    suggestion:
      'Run `bun audit` manually to diagnose (registry access is required), or pass --no-deps to skip the scan intentionally.',
  })
  return { status: 'unavailable', tool: 'bun audit' }
}

/**
 * Pure conversion from a finished `bun audit --json` invocation. Exported
 * for tests; `startDependencyScan` supplies the real subprocess output.
 */
export function dependencyFindingsFromScan(
  stdout: string,
  exitCode: number,
  findings: AuditFinding[],
  stderr = '',
): DependencyScan {
  const detail = stderr.trim() || undefined

  if (exitCode > 1) {
    return scanFailure(findings, `bun audit exited with code ${exitCode}`, detail)
  }

  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch {
    return scanFailure(findings, 'bun audit produced no JSON', detail)
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return scanFailure(findings, BAD_SHAPE, detail)
  }

  // Committed only on success: a shape failure halfway through must not leave a
  // half-parsed advisory list next to an "unavailable" status.
  const parsed: AuditFinding[] = []
  const seen = new Set<string>()

  for (const [pkg, advisories] of Object.entries(report as Record<string, unknown>)) {
    if (!Array.isArray(advisories)) {
      return scanFailure(findings, BAD_SHAPE, detail)
    }
    for (const advisory of advisories as BunAuditAdvisory[]) {
      if (typeof advisory?.url !== 'string' || typeof advisory?.severity !== 'string') {
        return scanFailure(findings, BAD_SHAPE, detail)
      }

      // The same advisory appears once per affected version range.
      const ghsa = advisory.url.match(GHSA_PATTERN)?.[0].toUpperCase() ?? advisory.url
      const key = `deps:${pkg}:${ghsa}`
      if (seen.has(key)) continue
      seen.add(key)

      const severity = advisory.severity.toLowerCase()
      parsed.push({
        key,
        title: `${pkg} dependency`,
        status: severity === 'critical' || severity === 'high' ? 'fail' : 'warn',
        message: `${severity} advisory (${advisory.vulnerable_versions}): ${advisory.title}`,
        suggestion: `Update ${pkg} to a patched release (see ${advisory.url}), or record an ignore with a reason in config/audit.ts.`,
      })
    }
  }

  // Exit 1 is bun audit's "vulnerabilities found" contract: an exit-1 run
  // reporting none is contradicting itself and must not read as a clean pass.
  if (exitCode === 1 && parsed.length === 0) {
    return scanFailure(findings, 'bun audit exited 1 but reported no advisories', detail)
  }

  if (parsed.length === 0) {
    parsed.push({
      key: 'deps:none',
      title: 'Dependency scan',
      status: 'pass',
      message: 'No known vulnerabilities in installed dependencies.',
    })
  }

  findings.push(...parsed)
  return { status: 'complete', tool: 'bun audit' }
}

export interface DependencyScanOutput {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Kick off `bun audit --json` without awaiting it, so the registry
 * round-trip can overlap the local file scanning. `null` means the process
 * could not even start.
 */
export function startDependencyScan(cwd: string): Promise<DependencyScanOutput | null> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([process.execPath, 'audit', '--json'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
  } catch {
    return Promise.resolve(null)
  }

  return Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }))
}

export function dependencyFindingsFromOutput(
  output: DependencyScanOutput | null,
  findings: AuditFinding[],
): DependencyScan {
  if (output === null) {
    return scanFailure(findings, 'bun audit could not be started')
  }
  return dependencyFindingsFromScan(output.stdout, output.exitCode, findings, output.stderr)
}
