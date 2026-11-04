import { describe, expect, it } from 'bun:test'
import type { AuditFinding } from '../src/audit'
import { attachExposures, exposureUnavailable } from '../src/dependency-advisory-exposure'
import type { ExposedPackage } from '../src/dependency-exposure'
import type { DependencyExposure } from '../src/dependency-exposure-load'

const instance = (id: string, attribution: ExposedPackage['attribution'] = 'routes'): ExposedPackage => ({
  id,
  name: id.slice(0, id.lastIndexOf('@')),
  version: id.slice(id.lastIndexOf('@') + 1),
  installedAs: [id.slice(0, id.lastIndexOf('@'))],
  direct: true,
  paths: { [id.slice(0, id.lastIndexOf('@'))]: [id.slice(0, id.lastIndexOf('@'))] },
  placement: [{ at: 'server', evidence: 'import' }],
  attribution,
  viaFramework: false,
  importedBy: [],
  routes: [],
})

function exposure(packages: ExposedPackage[], tree: 'complete' | 'partial' = 'complete'): DependencyExposure {
  const complete = { status: 'complete' as const, reasons: [] }
  return {
    schemaVersion: 1,
    snapshot: { id: 'snap', graph: 'graph', capturedAt: '2026-11-04T00:00:00.000Z', consistency: 'stable' },
    lockfile: 'bun.lock',
    workspace: '',
    coverage: {
      tree: tree === 'complete' ? complete : { status: 'partial', reasons: [{ code: 'unresolved', message: 'x' }] },
      imports: complete,
      placement: complete,
      graph: complete,
      runtime: { status: 'unavailable', reasons: [] },
    },
    packages,
    runtime: [],
  }
}

const advisoryFinding = (name: string, ranges: string[]): AuditFinding => ({
  key: `deps:${name}:GHSA-AAAA-BBBB-CCCC`,
  title: `${name} dependency`,
  status: 'fail',
  message: 'high advisory',
  advisory: { package: name, ghsa: 'GHSA-AAAA-BBBB-CCCC', ranges },
})

describe('attachExposures', () => {
  it('attaches every installed instance inside any of the advisory ranges, and only those', () => {
    const findings = [advisoryFinding('js-yaml', ['>=4.0.0 <4.3.0', '>=3.0.0 <3.15.0']), { key: 'deps:none', title: 'Dependency scan', status: 'pass' as const, message: 'ok' }]

    const summary = attachExposures(findings, exposure([instance('js-yaml@4.1.0'), instance('js-yaml@3.14.1'), instance('js-yaml@4.3.0'), instance('yaml@2.0.0')]))

    expect(findings[0]!.exposures?.map((entry) => entry.id)).toEqual(['js-yaml@4.1.0', 'js-yaml@3.14.1'])
    expect(findings[0]!.exposureReason).toBeUndefined()
    expect(findings[1]!.exposures).toBeUndefined()
    expect(summary).toMatchObject({ snapshot: { id: 'snap' }, coverage: { tree: { status: 'complete' } } })
  })

  it('says why an advisory has no instance in range, rather than leaving an empty list', () => {
    const complete = [advisoryFinding('js-yaml', ['<4.0.0'])]
    const partial = [advisoryFinding('js-yaml', ['<4.0.0'])]

    attachExposures(complete, exposure([instance('js-yaml@4.1.0')]))
    attachExposures(partial, exposure([], 'partial'))

    expect(complete[0]!).toMatchObject({ exposures: [], exposureReason: expect.stringContaining('treat it as exposed') })
    expect(partial[0]!.exposureReason).toContain('The lockfile tree is partial')
  })

  it('points at another workspace when the app shares its lockfile', () => {
    const findings = [advisoryFinding('minimatch', ['<11.0.1'])]

    attachExposures(findings, { ...exposure([]), lockfile: '../../bun.lock', workspace: 'examples/blog' })

    expect(findings[0]!.exposureReason).toBe('No instance of minimatch this app installs is inside <11.0.1. bun audit reads every workspace of ../../bun.lock, so another workspace may hold it; if none does, treat it as exposed.')
  })

  it('reads a range Bun cannot parse as holding the version', () => {
    const findings = [advisoryFinding('js-yaml', ['not a range'])]

    attachExposures(findings, exposure([instance('js-yaml@4.1.0')]))

    expect(findings[0]!.exposures?.map((entry) => entry.id)).toEqual(['js-yaml@4.1.0'])
  })
})

describe('exposureUnavailable', () => {
  it('names the failure on every advisory and in the summary', () => {
    const findings = [advisoryFinding('js-yaml', ['<4.0.0'])]

    const summary = exposureUnavailable(findings, new Error('graph timed out'))

    expect(summary).toEqual({ error: { code: 'collection-failed', message: 'Dependency exposure could not be collected (graph timed out).' } })
    expect(findings[0]!.exposureReason).toBe('Dependency exposure could not be collected (graph timed out).')
  })
})
