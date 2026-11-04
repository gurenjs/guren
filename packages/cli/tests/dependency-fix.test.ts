import { describe, expect, it } from 'bun:test'
import type { ExposedPackage } from '../src/dependency-exposure'
import { lowestFixed, OVERRIDE_NOTE, proposeFix, type Packument, type PackumentReader } from '../src/dependency-fix'

const packument = (versions: Record<string, Record<string, string> | undefined>, deprecated: string[] = []): Packument => ({
  versions: Object.fromEntries(Object.entries(versions).map(([version, dependencies]) => [version, {
    ...(dependencies ? { dependencies } : {}),
    ...(deprecated.includes(version) ? { deprecated: 'do not use' } : {}),
  }])),
})

const reader = (packuments: Record<string, Packument>): PackumentReader => async (name) => packuments[name] ?? null

const instance = (name: string, version: string, paths: Record<string, string[]>): ExposedPackage => ({
  id: `${name}@${version}`,
  name,
  version,
  installedAs: [name],
  direct: Object.values(paths).some((path) => path.length === 1),
  paths,
  placement: [],
  attribution: 'routes',
  viaFramework: false,
  importedBy: [],
  routes: [],
})

const advisory = { package: 'leaf', ghsa: 'GHSA-AAAA-BBBB-CCCC', ranges: ['<1.2.0', '>=2.0.0 <2.1.0'] }

describe('lowestFixed', () => {
  it('takes the lowest release past the installed one outside every range, in its major first', () => {
    const leaf = packument({ '1.1.0': {}, '1.2.0-beta.1': {}, '1.2.0': {}, '1.3.0': {}, '2.0.0': {}, '2.1.0': {} })

    expect(lowestFixed(leaf, '1.1.0', advisory.ranges)).toBe('1.2.0')
    expect(lowestFixed(leaf, '2.0.0', advisory.ranges)).toBe('2.1.0')
  })

  it('skips deprecated releases and crosses a major only when its own has no fix', () => {
    expect(lowestFixed(packument({ '1.1.0': {}, '1.2.0': {}, '1.3.0': {} }, ['1.2.0']), '1.1.0', advisory.ranges)).toBe('1.3.0')
    expect(lowestFixed(packument({ '1.1.0': {}, '2.0.5': {}, '3.0.0': {} }), '1.1.0', ['<2.1.0'])).toBe('3.0.0')
    expect(lowestFixed(packument({ '1.1.0': {} }), '1.1.0', advisory.ranges)).toBeNull()
  })
})

describe('proposeFix', () => {
  it('updates a direct instance to its lowest fixed release', async () => {
    const fix = await proposeFix({
      advisory,
      exposures: [instance('leaf', '1.1.0', { leaf: ['leaf'] })],
      installed: [],
      read: reader({ leaf: packument({ '1.1.0': {}, '1.2.0': {} }) }),
    })

    expect(fix).toEqual({ status: 'candidate', steps: [{ kind: 'update', package: 'leaf', to: '1.2.0' }] })
  })

  it('updates the direct dependency on a path to the lowest release whose tree leaves the range', async () => {
    const exposed = instance('leaf', '1.1.0', { top: ['top', 'middle', 'leaf'] })

    const fix = await proposeFix({
      advisory,
      exposures: [exposed],
      installed: [instance('top', '1.0.0', { top: ['top'] })],
      read: reader({
        top: packument({ '1.0.0': { middle: '^1.0.0' }, '1.1.0': { middle: '^1.0.0' }, '1.2.0': { middle: '^2.0.0' } }),
        middle: packument({ '1.0.0': { leaf: '^1.0.0' }, '1.5.0': { leaf: '~1.1.0' }, '2.0.0': { leaf: '^1.2.0' } }),
        leaf: packument({ '1.1.0': {}, '1.2.0': {} }),
      }),
    })

    expect(fix.steps).toEqual([{ kind: 'update', package: 'top', to: '1.2.0' }])
  })

  it('counts a release that no longer depends on the next package as leaving the range', async () => {
    const fix = await proposeFix({
      advisory,
      exposures: [instance('leaf', '1.1.0', { top: ['top', 'leaf'] })],
      installed: [instance('top', '1.0.0', { top: ['top'] })],
      read: reader({ top: packument({ '1.0.0': { leaf: '^1.0.0' }, '2.0.0': {} }), leaf: packument({ '1.1.0': {} }) }),
    })

    expect(fix.steps).toEqual([{ kind: 'update', package: 'top', to: '2.0.0' }])
  })

  it('falls back to an override when no release of the direct dependency leaves the range', async () => {
    const fix = await proposeFix({
      advisory,
      exposures: [instance('leaf', '1.1.0', { top: ['top', 'leaf'] })],
      installed: [instance('top', '1.0.0', { top: ['top'] })],
      read: reader({ top: packument({ '1.0.0': { leaf: '~1.1.0' }, '1.0.1': { leaf: '~1.1.0' } }), leaf: packument({ '1.1.0': {}, '1.2.0': {} }) }),
    })

    expect(fix).toEqual({ status: 'candidate', steps: [{ kind: 'override', package: 'leaf', to: '1.2.0', note: OVERRIDE_NOTE }] })
  })

  it('is unavailable, with the reason, when the registry does not answer or no release is fixed', async () => {
    const exposures = [instance('leaf', '1.1.0', { leaf: ['leaf'] })]

    expect(await proposeFix({ advisory, exposures, installed: [], read: reader({}) })).toEqual({ status: 'unavailable', reason: 'The registry did not answer for leaf.', steps: [] })
    expect((await proposeFix({ advisory, exposures, installed: [], read: reader({ leaf: packument({ '1.1.0': {} }) }) })).status).toBe('unavailable')
  })
})
