/**
 * The release-plan allowance in the plugin compatibility audit: a package
 * depending on a subpath introduced in the same release must name a version
 * that does not exist until `changeset version` runs. These cover the allowance
 * and the three ways it must still say no.
 */
import { describe, test, expect } from 'bun:test'
import { parseChangeset, type ParsedChangeset } from './core-semver-audit'
import {
  auditPackages,
  plannedVersion,
  plannedVersions,
  rangeAtRelease,
  type AuditablePackage,
} from './plugin-compat-audit'

const CORE = '@guren/core'
const SERVER = '@guren/server'

function changeset(file: string, body: string): ParsedChangeset {
  return parseChangeset(file, body)
}

/** The plan this very release carries: core and server both minor. */
function releasePlan(): ParsedChangeset[] {
  return [
    changeset('core.md', `---\n'${CORE}': minor\n---\n\nMirror the agent subpath.\n`),
    changeset('server.md', `---\n'${SERVER}': minor\n---\n\nAdd the agent subpath.\n`),
  ]
}

const workspace = new Map([
  [CORE, '1.12.0'],
  [SERVER, '2.14.0'],
  ['@guren/plugin-webmcp', '0.0.0'],
])

/**
 * A dependency range admitting the version on disk (anything else breaks
 * `bun install --frozen-lockfile`) beside a compatibility claim needing core
 * 1.13.0. The two are reconciled when `changeset version` raises the range.
 */
function webmcpPackage(coreRange = '^1.12.0', compatibility = '>=1.13.0 <2.0.0'): AuditablePackage {
  return {
    name: '@guren/plugin-webmcp',
    dirName: 'plugin-webmcp',
    relativeDir: 'packages/plugin-webmcp',
    manifest: {
      dependencies: { [CORE]: coreRange },
      gurenPlugin: { compatibility },
    },
  }
}

/** `@guren/core` itself, depending on the server subpath added in this plan. */
function corePackage(serverRange = '^2.14.0'): AuditablePackage {
  return {
    name: CORE,
    dirName: 'core',
    relativeDir: 'packages/core',
    manifest: { dependencies: { [SERVER]: serverRange } },
  }
}

describe('plannedVersion', () => {
  test('should apply the bump the release plan declares', () => {
    expect(plannedVersion('1.12.0', 'minor')).toBe('1.13.0')
    expect(plannedVersion('2.14.3', 'major')).toBe('3.0.0')
    expect(plannedVersion('2.14.3', 'patch')).toBe('2.14.4')
  })

  test('should answer nothing for a package the plan holds', () => {
    // `none` is a real changeset bump and means "released, unchanged" — it
    // cannot excuse a range that excludes the current version.
    expect(plannedVersion('1.12.0', 'none')).toBeNull()
  })
})

describe('plannedVersions', () => {
  test('should take the loudest bump across the plan', () => {
    const planned = plannedVersions(workspace, [
      changeset('a.md', `---\n'${CORE}': patch\n---\n\nOne.\n`),
      changeset('b.md', `---\n'${CORE}': minor\n---\n\nTwo.\n`),
      changeset('c.md', `---\n'${CORE}': patch\n---\n\nThree.\n`),
    ])
    expect(planned.get(CORE)).toBe('1.13.0')
  })

  test('should ignore a package this workspace does not publish', () => {
    const planned = plannedVersions(workspace, [
      changeset('x.md', "---\n'@acme/elsewhere': major\n---\n\nNot ours.\n"),
    ])
    expect(planned.has('@acme/elsewhere')).toBe(false)
  })
})

describe('rangeAtRelease', () => {
  test('should raise a floor changeset version will rewrite', () => {
    // Measured against `changeset version` in a disposable copy of this
    // workspace: `updateInternalDependencies: "patch"` rewrites on any bump.
    expect(rangeAtRelease('^1.12.0', '1.13.0')).toBe('^1.13.0')
    expect(rangeAtRelease('~2.14.0', '2.15.0')).toBe('~2.15.0')
    expect(rangeAtRelease('1.12.0', '1.13.0')).toBe('1.13.0')
  })

  test('should carry a major bump, interval and all', () => {
    // The operator survives, so the range is probed across 2.x — which is what
    // must fail a compatibility range stuck below that major.
    expect(rangeAtRelease('^1.12.0', '2.0.0')).toBe('^2.0.0')
  })

  test('should leave a range alone when nothing raises it', () => {
    expect(rangeAtRelease('^1.12.0', undefined)).toBe('^1.12.0')
    // A planned version at or below the floor is not a rewrite.
    expect(rangeAtRelease('^1.13.0', '1.13.0')).toBe('^1.13.0')
    expect(rangeAtRelease('^1.13.0', '1.12.0')).toBe('^1.13.0')
  })

  test('should not rewrite a shape the prober cannot read', () => {
    // Untouched, so it still reaches the `unreasoned` path.
    expect(rangeAtRelease('>=1.0.0 <2.0.0', '1.13.0')).toBe('>=1.0.0 <2.0.0')
    expect(rangeAtRelease('^1.12.0 || ^2.0.0', '1.13.0')).toBe('^1.12.0 || ^2.0.0')
  })
})

describe('auditPackages with a pending release plan', () => {
  const planned = () => plannedVersions(workspace, releasePlan())

  test('should accept a compatibility floor the plan is about to make true', () => {
    const result = auditPackages([webmcpPackage(), corePackage()], workspace, planned())

    // Compatibility says >=1.13.0 while the workspace holds 1.12.0; the plan
    // publishes 1.13.0 and raises the range, so what ships is consistent.
    expect(result.drift).toEqual([])
    expect(result.unreasoned).toEqual([])
  })

  test('should reject a compatibility floor no pending release reaches', () => {
    // (i) No core changeset, so nothing publishes 1.13.0 and npm really can
    // pair this plugin with core 1.12.0, which `guren plugin` refuses to load.
    const withoutCore = plannedVersions(workspace, [
      changeset('server.md', `---\n'${SERVER}': minor\n---\n\nAdd the agent subpath.\n`),
    ])
    const result = auditPackages([webmcpPackage()], workspace, withoutCore)

    const floorDrift = result.drift.filter((line) => line.includes('gurenPlugin.compatibility'))
    expect(floorDrift.length).toBeGreaterThan(0)
    expect(result.drift.join('\n')).toContain('1.12.0')
  })

  test('should reject a compatibility floor the plan still does not reach', () => {
    // (ii) The range becomes ^1.13.0, whose floor a >=1.14.0 claim still
    // excludes: the allowance must not launder a floor past the release.
    const result = auditPackages([webmcpPackage('^1.12.0', '>=1.14.0 <2.0.0')], workspace, planned())

    expect(result.drift.join('\n')).toContain('excludes @guren/core 1.13.0')
    expect(result.drift.join('\n')).toContain('this release will publish')
  })

  test('should judge compatibility against the workspace when the range shape is unreadable', () => {
    // With rule (a) abstaining into `unreasoned` on an unreadable shape, the
    // compatibility-vs-workspace check is the only thing left judging the
    // claim. Without this case it could be deleted and everything still pass.
    const result = auditPackages(
      [webmcpPackage('>=1.12.0 <2.0.0', '>=1.13.0 <2.0.0')],
      workspace,
      new Map(),
    )

    expect(result.unreasoned.join('\n')).toContain('a shape this audit cannot reason about')
    const floorDrift = result.drift.filter((line) => line.includes('gurenPlugin.compatibility is'))
    expect(floorDrift).toHaveLength(1)
    expect(floorDrift[0]).toContain('excludes the workspace @guren/core 1.12.0')
  })

  test('should reject a compatibility range the plan is about to major past', () => {
    // The allowance's dangerous direction: a majoring plan writes ^2.0.0, whose
    // 2.x ">=1.13.0 <2.0.0" excludes. Raising the interval must be able to
    // *create* drift, not only clear it.
    const majorPlan = plannedVersions(workspace, [
      changeset('core.md', `---\n'${CORE}': major\n---\n\nBreaking.\n`),
    ])
    const result = auditPackages([webmcpPackage()], workspace, majorPlan)

    expect(result.drift.join('\n')).toContain('this release will publish')
    expect(result.drift.join('\n')).toContain('^2.0.0')
  })

  test('should reject a dependency range that excludes the version on disk', () => {
    // A forward floor reads as honest, but Bun links a workspace package only
    // through a range admitting the version on disk and otherwise looks to npm,
    // so `--frozen-lockfile` cannot resolve it. No allowance here, deliberately.
    const result = auditPackages([webmcpPackage('^1.13.0')], workspace, planned())

    const dependencyDrift = result.drift.filter((line) =>
      line.includes('dependencies["@guren/core"]'),
    )
    expect(dependencyDrift).toHaveLength(1)
    expect(dependencyDrift[0]).toContain('frozen-lockfile')
  })

  test('should still pass once the release has happened and no plan is pending', () => {
    // (iii) After the release: nothing may depend on a plan still being there.
    const bumped = new Map([
      [CORE, '1.13.0'],
      [SERVER, '2.15.0'],
      ['@guren/plugin-webmcp', '0.1.0'],
    ])
    const result = auditPackages(
      [webmcpPackage('^1.13.0'), corePackage('^2.15.0')],
      bumped,
      new Map(),
    )

    expect(result.drift).toEqual([])
    expect(result.unreasoned).toEqual([])
  })

  test('should keep failing a plugin whose compatibility excludes its own core range', () => {
    // Rule (a): the shipped range's ceiling, which no allowance touches.
    const result = auditPackages(
      [webmcpPackage('^1.12.0', '>=1.13.0 <1.14.0')],
      workspace,
      planned(),
    )

    expect(result.drift.join('\n')).toContain('excludes @guren/core 1.9999.9999')
  })

  test('should keep failing a packages/plugin-* directory with no gurenPlugin manifest', () => {
    const result = auditPackages(
      [
        {
          name: '@guren/plugin-bare',
          dirName: 'plugin-bare',
          relativeDir: 'packages/plugin-bare',
          manifest: { dependencies: { [CORE]: '^1.13.0' } },
        },
      ],
      workspace,
      planned(),
    )

    expect(result.drift.join('\n')).toContain('declares no "gurenPlugin" manifest')
  })
})
