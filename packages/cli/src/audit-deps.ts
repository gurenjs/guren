import type { AuditFinding } from './audit'

/**
 * Dependency vulnerability scan for `guren audit` (RFC 0007): runs
 * `bun audit --json` in the app and converts advisories into findings.
 *
 * Parsing rules: `bun audit` exits 0 (clean) or 1 (advisories found) with
 * valid JSON either way; any other exit code is an execution/registry
 * failure. A proxy can also answer with JSON that merely *parses* — an
 * error object instead of the package→advisories map — so the shape is
 * validated, not assumed. "Could not scan" is reported as its own finding
 * and status, never as a pass: an offline machine must not look identical
 * to a clean one.
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
 * for tests; `auditDependencies` supplies the real subprocess output.
 */
export function dependencyFindingsFromScan(
  stdout: string,
  exitCode: number,
  findings: AuditFinding[],
): DependencyScan {
  if (exitCode > 1) {
    return scanFailure(findings, `bun audit exited with code ${exitCode}`)
  }

  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch {
    return scanFailure(findings, 'bun audit produced no JSON')
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return scanFailure(findings, 'unrecognized bun audit output shape')
  }

  // Collected locally and committed only on success: a shape failure halfway
  // through must not leave a half-parsed advisory list next to an
  // "unavailable" status.
  const parsed: AuditFinding[] = []
  const seen = new Set<string>()

  for (const [pkg, advisories] of Object.entries(report as Record<string, unknown>)) {
    if (!Array.isArray(advisories)) {
      return scanFailure(findings, 'unrecognized bun audit output shape')
    }
    for (const advisory of advisories as BunAuditAdvisory[]) {
      if (typeof advisory?.url !== 'string' || typeof advisory?.severity !== 'string') {
        return scanFailure(findings, 'unrecognized bun audit output shape')
      }

      // The same advisory appears once per affected version range; one
      // finding per package+advisory is what a human (or CI) acts on.
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

export async function auditDependencies(cwd: string, findings: AuditFinding[]): Promise<DependencyScan> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([process.execPath, 'audit', '--json'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
  } catch (error) {
    return scanFailure(findings, 'bun audit could not be started', error instanceof Error ? error.message : undefined)
  }

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    proc.exited,
  ])

  return dependencyFindingsFromScan(stdout, exitCode, findings)
}
