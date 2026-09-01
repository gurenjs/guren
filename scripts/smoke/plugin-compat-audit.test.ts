/**
 * The release-plan allowance in the plugin compatibility audit.
 *
 * The audit's original rule — every `@guren/*` range must admit the version
 * this *workspace* holds — makes one honest manifest unwritable: a package
 * that depends on a subpath introduced in the same release has to name a
 * version that does not exist until `changeset version` runs. These cover the
 * allowance that fixes it, and the three ways it must still say no.
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
 * The plugin as this branch declares it: a dependency range that admits the
 * version on disk (anything else breaks `bun install --frozen-lockfile`), and
 * a compatibility claim stating the truth — the client needs core 1.13.0 for
 * `@guren/core/agent`. The two are reconciled at release, when
 * `changeset version` raises the range.
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
    // `changeset version` applies the maximum across a plan, not each in turn.
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
    // workspace: with updateInternalDependencies "patch" it rewrites an
    // internal range on any bump, not only when the range stops admitting.
    expect(rangeAtRelease('^1.12.0', '1.13.0')).toBe('^1.13.0')
    expect(rangeAtRelease('~2.14.0', '2.15.0')).toBe('~2.15.0')
    expect(rangeAtRelease('1.12.0', '1.13.0')).toBe('1.13.0')
  })

  test('should carry a major bump, interval and all', () => {
    // The operator survives, so rangeProbes recomputes the ceiling from the
    // new major and the range is probed across 2.x — which is what changesets
    // writes, and what has to make a compatibility range stuck below that
    // major fail rather than pass.
    expect(rangeAtRelease('^1.12.0', '2.0.0')).toBe('^2.0.0')
  })

  test('should leave a range alone when nothing raises it', () => {
    expect(rangeAtRelease('^1.12.0', undefined)).toBe('^1.12.0')
    // A planned version at or below the floor is not a rewrite.
    expect(rangeAtRelease('^1.13.0', '1.13.0')).toBe('^1.13.0')
    expect(rangeAtRelease('^1.13.0', '1.12.0')).toBe('^1.13.0')
  })

  test('should not rewrite a shape the prober cannot read', () => {
    // Returned untouched so it still reaches the `unreasoned` path rather
    // than being quietly normalised into something checkable.
    expect(rangeAtRelease('>=1.0.0 <2.0.0', '1.13.0')).toBe('>=1.0.0 <2.0.0')
    expect(rangeAtRelease('^1.12.0 || ^2.0.0', '1.13.0')).toBe('^1.12.0 || ^2.0.0')
  })
})

describe('auditPackages with a pending release plan', () => {
  const planned = () => plannedVersions(workspace, releasePlan())

  test('should accept a compatibility floor the plan is about to make true', () => {
    const result = auditPackages([webmcpPackage(), corePackage()], workspace, planned())

    // Compatibility says >=1.13.0 while the workspace holds 1.12.0, and the
    // dependency range is ^1.12.0 because nothing else installs. The plan
    // publishes core 1.13.0 and `changeset version` raises the range to
    // ^1.13.0, so what ships is consistent. This is the case the allowance
    // exists for.
    expect(result.drift).toEqual([])
    expect(result.unreasoned).toEqual([])
  })

  test('should reject a compatibility floor no pending release reaches', () => {
    // (i) The core changeset is gone, so nothing publishes 1.13.0, the range
    // is never raised, and npm really can pair this plugin with core 1.12.0 —
    // which `guren plugin` then refuses to load.
    const withoutCore = plannedVersions(workspace, [
      changeset('server.md', `---\n'${SERVER}': minor\n---\n\nAdd the agent subpath.\n`),
    ])
    const result = auditPackages([webmcpPackage()], workspace, withoutCore)

    const floorDrift = result.drift.filter((line) => line.includes('gurenPlugin.compatibility'))
    expect(floorDrift.length).toBeGreaterThan(0)
    expect(result.drift.join('\n')).toContain('1.12.0')
  })

  test('should reject a compatibility floor the plan still does not reach', () => {
    // (ii) The plan publishes 1.13.0, so the range becomes ^1.13.0 — whose
    // floor a >=1.14.0 claim still excludes. The allowance must not launder a
    // floor beyond what the release produces.
    const result = auditPackages([webmcpPackage('^1.12.0', '>=1.14.0 <2.0.0')], workspace, planned())

    expect(result.drift.join('\n')).toContain('excludes @guren/core 1.13.0')
    expect(result.drift.join('\n')).toContain('this release will publish')
  })

  test('should judge compatibility against the workspace when the range shape is unreadable', () => {
    // Isolates the compatibility-vs-workspace check. Rule (a) probes the ends
    // of a caret; given a range shape it cannot read it abstains into
    // `unreasoned`, and this check is the only thing left judging the claim —
    // asked through the same checkPluginCompatibility() `guren plugin` calls.
    // Without a case where rule (a) stays silent, that check could be
    // disabled outright and every other test here would still pass.
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
    // The allowance's dangerous direction. A plan that majors core makes
    // changeset version write ^2.0.0, so the published range admits 2.x that
    // ">=1.13.0 <2.0.0" excludes — exactly the "installs cleanly, then
    // refuses to load" pairing this script exists to prevent. Raising the
    // interval must therefore be able to *create* drift, not only clear it.
    const majorPlan = plannedVersions(workspace, [
      changeset('core.md', `---\n'${CORE}': major\n---\n\nBreaking.\n`),
    ])
    const result = auditPackages([webmcpPackage()], workspace, majorPlan)

    expect(result.drift.join('\n')).toContain('this release will publish')
    expect(result.drift.join('\n')).toContain('^2.0.0')
  })

  test('should reject a dependency range that excludes the version on disk', () => {
    // The mistake that turned CI red: a forward floor reads as the honest
    // claim, but Bun links a workspace package only through a range admitting
    // the version on disk and otherwise looks to npm, where it does not exist
    // — `bun install --frozen-lockfile` cannot resolve it. There is
    // deliberately no release-plan allowance on this check, even though the
    // plan does publish 1.13.0.
    const result = auditPackages([webmcpPackage('^1.13.0')], workspace, planned())

    const dependencyDrift = result.drift.filter((line) =>
      line.includes('dependencies["@guren/core"]'),
    )
    expect(dependencyDrift).toHaveLength(1)
    expect(dependencyDrift[0]).toContain('frozen-lockfile')
  })

  test('should still pass once the release has happened and no plan is pending', () => {
    // (iii) The after-the-fact state: versions already bumped, `.changeset/`
    // emptied by `changeset version`, and the ranges it rewrote. Nothing may
    // depend on a pending plan still being there.
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
    // Rule (a) proper: compatibility has to cover everything the range that
    // ships can resolve to — here the ceiling, which no allowance touches.
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
