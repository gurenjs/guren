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

/** The plugin as this branch declares it: honest about needing core 1.13.0. */
function webmcpPackage(coreRange = '^1.13.0', compatibility = '>=1.13.0 <2.0.0'): AuditablePackage {
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
function corePackage(serverRange = '^2.15.0'): AuditablePackage {
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

describe('auditPackages with a pending release plan', () => {
  const planned = () => plannedVersions(workspace, releasePlan())

  test('should accept a range naming the version this plan publishes', () => {
    const result = auditPackages([webmcpPackage(), corePackage()], workspace, planned())

    // Neither ^1.13.0 nor ^2.15.0 admits the workspace version; both admit
    // what the plan will publish. This is the case the allowance exists for.
    expect(result.drift).toEqual([])
    expect(result.unreasoned).toEqual([])
  })

  test('should reject the same range when the plan does not bump the dependency', () => {
    // (i) The core changeset is gone, so nothing will publish 1.13.0 and the
    // plugin's claim is simply wrong again.
    const withoutCore = plannedVersions(workspace, [
      changeset('server.md', `---\n'${SERVER}': minor\n---\n\nAdd the agent subpath.\n`),
    ])
    const result = auditPackages([webmcpPackage()], workspace, withoutCore)

    expect(result.drift).toHaveLength(2)
    expect(result.drift[0]).toContain('excludes the workspace @guren/core 1.12.0')
    expect(result.drift[1]).toContain('gurenPlugin.compatibility')
  })

  test('should reject a range the plan still does not reach', () => {
    // (ii) The plan publishes 1.13.0; ^1.14.0 names a version no release in
    // sight produces, so the allowance must not launder it.
    const result = auditPackages(
      [webmcpPackage('^1.14.0', '>=1.14.0 <2.0.0')],
      workspace,
      planned(),
    )

    // Both halves must refuse it independently. Asserting only that *some*
    // line was produced lets the dependency-range check degrade into "the
    // plan bumps this package at all" while the compatibility line keeps the
    // test green.
    const dependencyDrift = result.drift.filter((line) =>
      line.includes('dependencies["@guren/core"]'),
    )
    const compatibilityDrift = result.drift.filter((line) =>
      line.includes('gurenPlugin.compatibility is'),
    )
    expect(dependencyDrift).toHaveLength(1)
    expect(dependencyDrift[0]).toContain('and the 1.13.0 this release plan publishes')
    expect(compatibilityDrift).toHaveLength(1)
  })

  test('should still pass once the release has happened and no plan is pending', () => {
    // (iii) The after-the-fact state: versions already bumped, `.changeset/`
    // emptied by `changeset version`. Nothing may depend on a pending plan
    // still being there.
    const bumped = new Map([
      [CORE, '1.13.0'],
      [SERVER, '2.15.0'],
      ['@guren/plugin-webmcp', '0.1.0'],
    ])
    const result = auditPackages([webmcpPackage(), corePackage()], bumped, new Map())

    expect(result.drift).toEqual([])
    expect(result.unreasoned).toEqual([])
  })

  test('should keep failing a plugin whose compatibility excludes its own core range', () => {
    // The original rule (a), untouched by the allowance: compatibility has to
    // cover everything the declared dependency range can resolve to.
    const result = auditPackages(
      [webmcpPackage('^1.13.0', '>=1.13.0 <1.14.0')],
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
