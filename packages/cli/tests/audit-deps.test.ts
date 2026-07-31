import { describe, expect, it } from 'bun:test'
import type { AuditFinding } from '../src/audit'
import { dependencyFindingsFromScan } from '../src/audit-deps'

// Captured from a real `bun audit --json` run (bun 1.3.14) and trimmed:
// values are a map of package name → advisory list, advisories repeat per
// affected version range, and carry fields (id, cwe, cvss) beyond what the
// scan consumes — the parser must tolerate them.
const REAL_SHAPE = JSON.stringify({
  'js-yaml': [
    {
      id: 1123911,
      url: 'https://github.com/advisories/GHSA-52cp-r559-cp3m',
      title: 'js-yaml: YAML merge-key chains can force quadratic CPU consumption',
      severity: 'high',
      vulnerable_versions: '>=4.0.0 <4.3.0',
      cwe: ['CWE-400', 'CWE-407'],
      cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
    },
    {
      id: 1123912,
      url: 'https://github.com/advisories/GHSA-52cp-r559-cp3m',
      title: 'js-yaml: YAML merge-key chains can force quadratic CPU consumption',
      severity: 'high',
      vulnerable_versions: '>=3.0.0 <3.15.0',
      cwe: ['CWE-400', 'CWE-407'],
      cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
    },
  ],
  esbuild: [
    {
      id: 1102341,
      url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99',
      title: 'esbuild enables any website to send requests to the development server',
      severity: 'moderate',
      vulnerable_versions: '<=0.24.2',
      cwe: ['CWE-346'],
      cvss: { score: 5.3, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N' },
    },
  ],
})

describe('dependencyFindingsFromScan', () => {
  it('converts advisories to findings, one per package+advisory', () => {
    const findings: AuditFinding[] = []
    const scan = dependencyFindingsFromScan(REAL_SHAPE, 1, findings)

    expect(scan.status).toBe('complete')
    // Two js-yaml version ranges collapse into one finding.
    expect(findings.map((f) => f.key)).toEqual([
      'deps:js-yaml:GHSA-52CP-R559-CP3M',
      'deps:esbuild:GHSA-67MH-4WV8-2F99',
    ])
    expect(findings[0]!.status).toBe('fail') // high
    expect(findings[1]!.status).toBe('warn') // moderate
    expect(findings[0]!.message).toContain('quadratic CPU')
    expect(findings[1]!.suggestion).toContain('config/audit.ts')
  })

  it('reports a clean scan as a pass finding', () => {
    const findings: AuditFinding[] = []
    const scan = dependencyFindingsFromScan('{}', 0, findings)

    expect(scan.status).toBe('complete')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.key).toBe('deps:none')
    expect(findings[0]!.status).toBe('pass')
  })

  it('treats exit codes above 1 as scan-unavailable, never a pass', () => {
    const findings: AuditFinding[] = []
    const scan = dependencyFindingsFromScan('', 7, findings)

    expect(scan.status).toBe('unavailable')
    expect(findings[0]!.key).toBe('deps:scan')
    expect(findings[0]!.status).toBe('warn')
  })

  it('treats non-JSON and non-map JSON as scan-unavailable', () => {
    for (const stdout of ['registry timeout', '{"error":"blocked by proxy"}', '[]']) {
      const findings: AuditFinding[] = []
      const scan = dependencyFindingsFromScan(stdout, 1, findings)

      expect(scan.status).toBe('unavailable')
      expect(findings[0]!.key).toBe('deps:scan')
    }
  })
})

describe('dependencyFindingsFromScan partial failures', () => {
  it('does not leak half-parsed findings when a later entry is malformed', () => {
    const findings: AuditFinding[] = []
    const scan = dependencyFindingsFromScan(
      JSON.stringify({
        'ok-package': [
          {
            url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
            title: 'valid advisory',
            severity: 'high',
            vulnerable_versions: '<1.0.0',
          },
        ],
        'broken-package': 'not-an-array',
      }),
      1,
      findings,
    )

    expect(scan.status).toBe('unavailable')
    expect(findings.map((f) => f.key)).toEqual(['deps:scan'])
  })
})

describe('dependencyFindingsFromScan exit-code contract', () => {
  it('treats exit 1 with an empty report as scan-unavailable, not a clean pass', () => {
    // Exit 1 is bun audit's "vulnerabilities found" contract — an exit-1
    // run reporting none is contradicting itself (truncated output, a
    // broken wrapper) and must not produce deps:none.
    const findings: AuditFinding[] = []
    const scan = dependencyFindingsFromScan('{}', 1, findings)

    expect(scan.status).toBe('unavailable')
    expect(findings.map((f) => f.key)).toEqual(['deps:scan'])
  })

  it('surfaces stderr detail on scan failures', () => {
    const findings: AuditFinding[] = []
    dependencyFindingsFromScan('', 7, findings, 'error: registry unreachable\n')

    expect(findings[0]!.message).toContain('registry unreachable')
  })
})
