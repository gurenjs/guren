/**
 * Keep a plugin's two `@guren/core` version claims from contradicting each other.
 *
 * `changeset version` maintains one of the two and cannot see the other, which
 * is what makes them drift apart:
 *
 * - a `@guren/*` dependency range IS maintained. Verified against changesets
 *   directly: when a dependency crosses a major, a dependent whose range no
 *   longer admits it is added to the release plan and its range is rewritten
 *   (`^1.4.0` -> `^2.0.0`), even with no changeset of its own.
 * - `gurenPlugin.compatibility` is NOT. Changesets has no idea the field
 *   exists, so nothing moves it, ever — while `guren plugin` throws on a
 *   mismatch unless `--ignore-compatibility` is passed, and `guren doctor`
 *   reports it (see packages/cli/src/plugin.ts, doctor.ts).
 *
 * So the dangerous moment is not a range going stale on its own — it is the
 * release where changesets helpfully rewrites the dependency to `^2.0.0` and
 * leaves `compatibility: ">=1.0.0 <2.0.0"` sitting beside it. That manifest
 * installs cleanly from npm and then refuses to load. Nothing in the repo can
 * see it: workspace linking resolves `@guren/core` locally whatever the ranges
 * say, so build, typecheck and test stay green.
 *
 * This asserts:
 *
 *   (a) `compatibility` admits every `@guren/core` version the package's own
 *       core range can resolve to — the self-contradiction above.
 *   (b) every `@guren/*` range admits the version this workspace publishes for
 *       that package. A backstop rather than the main event, since changesets
 *       normally maintains this; it costs nothing and covers the hand-edit.
 *
 * Checked, never written. `compatibility` is a human judgment (a plugin may
 * legitimately support two majors), and at the one moment an auto-fix would
 * run — core crossing a major — writing `>=1.0.0 <3.0.0` would fabricate a
 * support claim for a port that has not happened.
 *
 * Runs in CI and again inside `version-packages`, immediately after
 * `changeset version`, which is the instant the contradiction gets created.
 *
 * Exit codes: 0 clean, 1 drifted claims, 2 the gate could not run — an
 * unresolvable workspace version, or a range shape this script cannot reason
 * about. Like `dependency-audit.ts`, an unavailable check is a failure rather
 * than a silent pass.
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

/**
 * Only the groups a consumer actually installs. A stale range in
 * `devDependencies` cannot pull a second copy into anyone's app, so it is not
 * this gate's business.
 */
const DEPENDENCY_GROUPS = ['dependencies', 'peerDependencies'] as const

export interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  gurenPlugin?: GurenPluginManifest
}

/**
 * Probe versions covering the extremes of a dependency range, labelled for the
 * failure message.
 *
 * `Bun.semver` has no range-subset primitive, and it does not need one for the
 * shapes declared here: each denotes one contiguous interval, so its reachable
 * set is bounded by its floor and its ceiling. Testing both ends against a
 * *contiguous* compatibility range is equivalent to testing the whole set. Any
 * other dependency shape returns null, and a non-contiguous compatibility range
 * is rejected separately by `contiguous()` — between them the caller fails
 * loudly instead of quietly checking nothing.
 *
 * The ceilings are the last version each range admits, so a probe is never
 * outside the range it describes. `^0.0.3` is the trap: unlike every other
 * caret it is locked all the way down to the patch, admitting only `0.0.3`.
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
    // ~1.4.0 -> <1.5.0
    ceiling = `${major}.${minor}.9999`
  } else {
    // An exact pin admits exactly itself.
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
 * probing only the ends of a caret sound. A union (`a || b`) can exclude an
 * interior version while admitting both ends, so it is refused rather than
 * approximated.
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
 * package. Below 1.0.0 it can differ, and that is left alone deliberately:
 * this value is only ever used to *admit* a range the workspace version
 * already fails, and no first-party package below 1.0.0 is depended on by
 * another one, so a wrong answer there cannot excuse a claim.
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
 * The version each package will be published at once the pending changesets
 * are applied — the loudest bump wins, since `changeset version` applies the
 * maximum across a plan rather than each in turn.
 *
 * This exists for one shape, and it is the shape of this very release: a
 * subpath (`@guren/core/agent`) introduced and *depended on* in the same
 * plan. The honest range is the version that does not exist yet, so checking
 * ranges against the workspace version alone makes the truthful manifest
 * unwritable and the false one mandatory. Only ranges the workspace version
 * fails are re-asked against the plan, so nothing that passes today starts
 * passing for a new reason.
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

/**
 * The audit proper, over already-read manifests, so it can be exercised
 * against synthetic workspaces instead of only against this checkout.
 */
export function auditPackages(
  packages: readonly AuditablePackage[],
  workspaceVersions: ReadonlyMap<string, string>,
  planned: ReadonlyMap<string, string>,
): CompatAuditResult {
  const coreVersion = workspaceVersions.get(CORE)!
  const plannedCore = planned.get(CORE)

  /** Claims that are wrong. */
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

    // (b) every @guren/* range must admit what this workspace publishes — or,
    // failing that, what this release plan will publish (see plannedVersions).
    for (const group of DEPENDENCY_GROUPS) {
      for (const [dependency, range] of Object.entries(manifest[group] ?? {})) {
        const version = workspaceVersions.get(dependency)
        // A @guren/* package this workspace does not publish resolves from npm
        // on its own terms; there is no workspace claim to contradict.
        if (!version) continue

        if (dependency === CORE) coreRanges.push(range)
        rangesChecked += 1

        if (Bun.semver.satisfies(version, range)) continue
        const next = planned.get(dependency)
        if (next && Bun.semver.satisfies(next, range)) continue
        drift.push(
          `${file}: ${group}["${dependency}"] is "${range}", which excludes the workspace ` +
            `${dependency} ${version}${next ? ` and the ${next} this release plan publishes` : ''}. ` +
            'Installing from npm would resolve a second, older copy alongside the app\'s.',
        )
      }
    }

    const plugin = manifest.gurenPlugin

    // The fields under audit are also what makes a package discoverable here, so
    // deleting one would otherwise buy silence. A packages/plugin-* directory is
    // asserted to be a plugin regardless of what its manifest currently says.
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

    // (b) the compatibility range must admit what this workspace publishes —
    // or, failing that, what this plan will publish, the same allowance the
    // dependency ranges get above. Asked through the same function `guren
    // plugin` and `guren doctor` call, so CI predicts the runtime decision
    // instead of re-deriving it.
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

    // (a) compatibility must cover everything the core range can resolve to.
    for (const declared of coreRanges) {
      const probes = rangeProbes(declared)
      if (!probes) {
        unreasoned.push(
          `${file}: the ${CORE} range "${declared}" is a shape this audit cannot reason about ` +
            `(it understands carets). Extend rangeProbes() in ${import.meta.path} rather than ` +
            'leaving the compatibility check silently vacuous.',
        )
        continue
      }

      for (const { end, version } of probes) {
        if (checkPluginCompatibility(plugin, version)?.compatible) continue
        drift.push(
          `${file}: gurenPlugin.compatibility "${compatibility}" excludes ${CORE} ${version}, ` +
            `which the declared range "${declared}" admits (${end} of its range). npm would ` +
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

  // Read through the core-semver audit's parser rather than a second one: a
  // changeset this repo accepts has exactly one definition, and that module
  // already refuses (rather than skips) anything it cannot read.
  const changesetDir = join(import.meta.dir, '..', '..', '.changeset')
  let planned: Map<string, string>
  try {
    planned = plannedVersions(workspaceVersions, await readChangesetDirectory(changesetDir))
  } catch (error) {
    // An unreadable release plan is a gate that could not run, never a clean
    // one — the same rule the rest of this script follows.
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
