/**
 * Keep a plugin's two `@guren/core` version claims from contradicting each other.
 *
 * `changeset version` rewrites a `@guren/*` dependency range but has no idea
 * `gurenPlugin.compatibility` exists, so the dangerous release is the one that
 * writes `^2.0.0` beside a `compatibility: ">=1.0.0 <2.0.0"`: it installs from
 * npm and then refuses to load, invisible in-repo because workspace linking
 * ignores the ranges. Checked, never written — compatibility is a human
 * judgment. Runs in CI and in `version-packages`. Exit 1 drift, 2 cannot run.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  checkPluginCompatibility,
  type GurenPluginManifest,
} from '../../packages/cli/src/plugin-manifest'
import { collectPackages, type WorkspacePackage } from '../workspace-packages'
import { readChangesetDirectory, type Bump, type ParsedChangeset } from './core-semver-audit'

const CORE = '@guren/core'

/** Only the groups a consumer installs; a stale devDependency pulls no copy. */
const DEPENDENCY_GROUPS = ['dependencies', 'peerDependencies'] as const

export interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  gurenPlugin?: GurenPluginManifest
}

/**
 * Probe versions covering the extremes of a dependency range, labelled for the
 * failure message. `Bun.semver` has no range-subset primitive, and for a
 * contiguous interval floor and ceiling are equivalent to the whole set; any
 * other shape returns null so the caller fails loudly. `^0.0.3` is the trap:
 * unlike every other caret it is locked to the patch, admitting only `0.0.3`.
 */
function rangeProbes(range: string): Array<{ end: string; version: string }> | null {
  const match = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range.trim())
  if (!match) return null

  const [, operator, major, minor, patch] = match
  const floor = `${major}.${minor}.${patch}`

  let ceiling: string
  if (operator === '^') {
    // ^1.4.0 -> <2.0.0 | ^0.2.1 -> <0.3.0 | ^0.0.3 -> <0.0.4
    ceiling =
      major !== '0' ? `${major}.9999.9999` : minor !== '0' ? `0.${minor}.9999` : floor
  } else if (operator === '~') {
    ceiling = `${major}.${minor}.9999`
  } else {
    ceiling = floor
  }

  return ceiling === floor
    ? [{ end: 'the only version', version: floor }]
    : [
        { end: 'floor', version: floor },
        { end: 'ceiling', version: ceiling },
      ]
}

/**
 * Whether a range denotes a single contiguous interval, which is what makes
 * probing only its ends sound: a union (`a || b`) can exclude an interior
 * version while admitting both ends, so it is refused rather than approximated.
 */
function contiguous(range: string): boolean {
  return !range.includes('||')
}

async function readManifest(pkg: WorkspacePackage): Promise<Manifest> {
  const path = join(pkg.dir, 'package.json')
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest
  } catch (cause) {
    throw new Error(`Failed to parse ${path}`, { cause })
  }
}

/**
 * The version `changeset version` will publish for a package, given what it
 * is on now and the loudest bump pending against it.
 *
 * Plain semver increment, which is what changesets applies to a >=1.0.0
 * package. Below 1.0.0 it can differ; left alone deliberately, since no
 * first-party package below 1.0.0 is depended on by another one.
 */
export function plannedVersion(current: string, bump: Bump): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!match || bump === 'none') return null
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const BUMP_ORDER: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

/**
 * The version each package will be published at once the pending changesets are
 * applied; the loudest bump wins, since `changeset version` applies the maximum
 * across a plan. Exists for the shape where a subpath is introduced and depended
 * on in the same plan, whose honest range names a version that does not exist
 * yet. Only ranges the workspace version fails are re-asked against the plan.
 */
export function plannedVersions(
  workspaceVersions: ReadonlyMap<string, string>,
  changesets: readonly ParsedChangeset[],
): Map<string, string> {
  const loudest = new Map<string, Bump>()
  for (const changeset of changesets) {
    for (const [name, bump] of changeset.releases) {
      const seen = loudest.get(name)
      if (seen === undefined || BUMP_ORDER[bump] > BUMP_ORDER[seen]) loudest.set(name, bump)
    }
  }

  const planned = new Map<string, string>()
  for (const [name, bump] of loudest) {
    const current = workspaceVersions.get(name)
    if (!current) continue
    const next = plannedVersion(current, bump)
    if (next) planned.set(name, next)
  }
  return planned
}

/**
 * The dependency range that will actually be *published*: `changeset version`
 * rewrites an internal `@guren/*` range on any bump (measured — `^1.12.0`
 * became `^1.13.0`), while the manifest must meanwhile admit the version on
 * disk or `--frozen-lockfile` fails. Only raises, only for the shapes
 * {@link rangeProbes} understands, and raises the whole interval.
 */
export function rangeAtRelease(declared: string, planned: string | undefined): string {
  if (!planned) return declared
  const match = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(declared.trim())
  if (!match) return declared
  const [, operator, version] = match as unknown as [string, string, string]
  if (Bun.semver.order(planned, version) <= 0) return declared
  return `${operator}${planned}`
}

/** One package's claims, as the audit reads them. */
export interface AuditablePackage {
  name: string
  dirName: string
  relativeDir: string
  private?: boolean
  manifest: Manifest
}

export interface CompatAuditResult {
  drift: string[]
  unreasoned: string[]
  rangesChecked: number
  manifestsChecked: number
}

/** Over already-read manifests, so synthetic workspaces can exercise it. */
export function auditPackages(
  packages: readonly AuditablePackage[],
  workspaceVersions: ReadonlyMap<string, string>,
  planned: ReadonlyMap<string, string>,
): CompatAuditResult {
  const coreVersion = workspaceVersions.get(CORE)!
  const plannedCore = planned.get(CORE)

  const drift: string[] = []
  /** Claims this script declined to judge — a gate that cannot run, not a pass. */
  const unreasoned: string[] = []

  let rangesChecked = 0
  let manifestsChecked = 0

  for (const pkg of packages) {
    if (pkg.private) continue

    const manifest = pkg.manifest
    const file = `${pkg.relativeDir}/package.json`
    const coreRanges: string[] = []

    // (b) every @guren/* range must admit what this workspace publishes. No
    // release-plan allowance here: a floor naming the version this release
    // introduces is broken now, because Bun falls through to npm and
    // `bun install --frozen-lockfile` cannot resolve it. `changeset version`
    // writes that floor at release instead (see rangeAtRelease).
    for (const group of DEPENDENCY_GROUPS) {
      for (const [dependency, range] of Object.entries(manifest[group] ?? {})) {
        const version = workspaceVersions.get(dependency)
        // Not published from this workspace: no claim to contradict.
        if (!version) continue

        if (dependency === CORE) coreRanges.push(range)
        rangesChecked += 1

        if (Bun.semver.satisfies(version, range)) continue
        drift.push(
          `${file}: ${group}["${dependency}"] is "${range}", which excludes the workspace ` +
            `${dependency} ${version}. Bun cannot link the workspace copy through a range that ` +
            'excludes it, so `bun install --frozen-lockfile` fails to resolve it from npm; and ' +
            'an install that did succeed would resolve a second, older copy alongside the app\'s.',
        )
      }
    }

    const plugin = manifest.gurenPlugin

    // The audited field is also what makes a package discoverable here, so a
    // packages/plugin-* directory is held to it however its manifest reads.
    if (!plugin) {
      if (pkg.dirName.startsWith('plugin-')) {
        drift.push(
          `${file}: ${pkg.name} lives in packages/${pkg.dirName} but declares no "gurenPlugin" ` +
            'manifest, so `guren plugin` cannot check it against any core version.',
        )
      }
      continue
    }
    manifestsChecked += 1

    if (coreRanges.length === 0) {
      drift.push(
        `${file}: declares a "gurenPlugin" manifest but no ${CORE} dependency in ` +
          `${DEPENDENCY_GROUPS.join(' or ')}. Its compatibility claim is then about a package ` +
          'the install never pulls in.',
      )
    }

    if (!plugin.compatibility) {
      drift.push(
        `${file}: gurenPlugin declares no "compatibility" range. A first-party plugin has to ` +
          `state which ${CORE} majors it supports, or this audit has nothing to hold to and ` +
          'the claim can rot unnoticed.',
      )
      continue
    }
    const compatibility = plugin.compatibility

    if (!contiguous(compatibility)) {
      unreasoned.push(
        `${file}: gurenPlugin.compatibility "${compatibility}" is a union range. Probing the ends ` +
          `of a dependency range cannot prove a union covers its interior — extend this audit ` +
          'before declaring one.',
      )
      continue
    }

    // (b) compatibility must admit what this workspace publishes, or what the
    // plan will. Asked through the same function `guren plugin` and `guren
    // doctor` call, so CI predicts the runtime decision rather than re-deriving.
    const current = checkPluginCompatibility(plugin, coreVersion)
    const againstPlan = plannedCore ? checkPluginCompatibility(plugin, plannedCore) : null
    if (current === null) {
      unreasoned.push(
        `${file}: checkPluginCompatibility() declined to judge "${compatibility}" against ` +
          `${CORE} ${coreVersion}.`,
      )
    } else if (!current.compatible && !againstPlan?.compatible) {
      drift.push(
        `${file}: gurenPlugin.compatibility is "${compatibility}", which excludes the workspace ` +
          `${CORE} ${coreVersion}` +
          `${plannedCore ? ` and the ${plannedCore} this release plan publishes` : ''}. ` +
          `\`guren plugin ${pkg.name}\` would throw for anyone installing it against this release.`,
      )
    }

    // (a) compatibility must cover everything the core range can resolve to —
    // the range as *published*, which is not always the one written here.
    // See rangeAtRelease.
    for (const declared of coreRanges) {
      const shipped = rangeAtRelease(declared, plannedCore)
      const probes = rangeProbes(shipped)
      if (!probes) {
        unreasoned.push(
          `${file}: the ${CORE} range "${shipped}" is a shape this audit cannot reason about ` +
            `(it understands carets). Extend rangeProbes() in ${import.meta.path} rather than ` +
            'leaving the compatibility check silently vacuous.',
        )
        continue
      }

      for (const { end, version } of probes) {
        if (checkPluginCompatibility(plugin, version)?.compatible) continue
        const which =
          shipped === declared
            ? `the declared range "${declared}"`
            : `the range "${shipped}" this release will publish (declared "${declared}")`
        drift.push(
          `${file}: gurenPlugin.compatibility "${compatibility}" excludes ${CORE} ${version}, ` +
            `which ${which} admits (${end} of its range). npm would ` +
            'install a combination the plugin loader then refuses.',
        )
      }
    }
  }

  return { drift, unreasoned, rangesChecked, manifestsChecked }
}

if (import.meta.main) {
  const packages = await collectPackages()
  const workspaceVersions = new Map(
    packages.flatMap((pkg) => (pkg.version ? [[pkg.name, pkg.version] as const] : [])),
  )

  const coreVersion = workspaceVersions.get(CORE)
  if (!coreVersion) {
    console.error(`plugin compatibility audit: could not read ${CORE}'s workspace version.`)
    process.exit(2)
  }

  // Through the core-semver audit's parser, not a second one: a changeset this
  // repo accepts has exactly one definition.
  const changesetDir = join(import.meta.dir, '..', '..', '.changeset')
  let planned: Map<string, string>
  try {
    planned = plannedVersions(workspaceVersions, await readChangesetDirectory(changesetDir))
  } catch (error) {
    // An unreadable release plan is a gate that could not run, never a clean one.
    console.error('plugin compatibility audit could not read the pending release plan.')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }

  const auditable: AuditablePackage[] = []
  for (const pkg of packages) {
    auditable.push({
      name: pkg.name,
      dirName: pkg.dirName,
      relativeDir: pkg.relativeDir,
      private: pkg.private,
      manifest: await readManifest(pkg),
    })
  }

  const { drift, unreasoned, rangesChecked, manifestsChecked } = auditPackages(
    auditable,
    workspaceVersions,
    planned,
  )

  for (const entry of drift) console.error(`[drift] ${entry}`)
  for (const entry of unreasoned) console.error(`[unchecked] ${entry}`)

  if (drift.length > 0) {
    console.error(
      `plugin compatibility audit failed: ${drift.length} drifted version claim(s) ` +
        `(${unreasoned.length} unchecked).`,
    )
    process.exit(1)
  }
  if (unreasoned.length > 0) {
    console.error(
      `plugin compatibility audit could not run: ${unreasoned.length} claim(s) this script ` +
        'declined to judge.',
    )
    process.exit(2)
  }

  const plan = planned.size > 0
    ? `, and the pending plan's ${[...planned].map(([n, v]) => `${n} ${v}`).join(', ')}`
    : ''
  console.log(
    `plugin compatibility audit passed (${rangesChecked} @guren/* ranges, ` +
      `${manifestsChecked} plugin manifests, against ${CORE} ${coreVersion}${plan}).`,
  )
}
