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

const CORE = '@guren/core'

/**
 * Only the groups a consumer actually installs. A stale range in
 * `devDependencies` cannot pull a second copy into anyone's app, so it is not
 * this gate's business.
 */
const DEPENDENCY_GROUPS = ['dependencies', 'peerDependencies'] as const

interface Manifest {
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

const packages = await collectPackages()
const workspaceVersions = new Map(
  packages.flatMap((pkg) => (pkg.version ? [[pkg.name, pkg.version] as const] : [])),
)

const coreVersion = workspaceVersions.get(CORE)
if (!coreVersion) {
  console.error(`plugin compatibility audit: could not read ${CORE}'s workspace version.`)
  process.exit(2)
}

/** Claims that are wrong. */
const drift: string[] = []
/** Claims this script declined to judge — a gate that cannot run, not a pass. */
const unreasoned: string[] = []

let rangesChecked = 0
let manifestsChecked = 0

for (const pkg of packages) {
  if (pkg.private) continue

  const manifest = await readManifest(pkg)
  const file = `${pkg.relativeDir}/package.json`
  const coreRanges: string[] = []

  // (b) every @guren/* range must admit what this workspace publishes.
  for (const group of DEPENDENCY_GROUPS) {
    for (const [dependency, range] of Object.entries(manifest[group] ?? {})) {
      const version = workspaceVersions.get(dependency)
      // A @guren/* package this workspace does not publish resolves from npm
      // on its own terms; there is no workspace claim to contradict.
      if (!version) continue

      if (dependency === CORE) coreRanges.push(range)
      rangesChecked += 1

      if (Bun.semver.satisfies(version, range)) continue
      drift.push(
        `${file}: ${group}["${dependency}"] is "${range}", which excludes the workspace ` +
          `${dependency} ${version}. Installing from npm would resolve a second, older ` +
          'copy alongside the app\'s.',
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

  // (b) the compatibility range must admit what this workspace publishes. Asked
  // through the same function `guren plugin` and `guren doctor` call, so CI
  // predicts the runtime decision instead of re-deriving it.
  const current = checkPluginCompatibility(plugin, coreVersion)
  if (current === null) {
    unreasoned.push(
      `${file}: checkPluginCompatibility() declined to judge "${compatibility}" against ` +
        `${CORE} ${coreVersion}.`,
    )
  } else if (!current.compatible) {
    drift.push(
      `${file}: gurenPlugin.compatibility is "${compatibility}", which excludes the workspace ` +
        `${CORE} ${coreVersion}. \`guren plugin ${pkg.name}\` would throw for anyone ` +
        'installing it against this release.',
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

console.log(
  `plugin compatibility audit passed (${rangesChecked} @guren/* ranges, ` +
    `${manifestsChecked} plugin manifests, against ${CORE} ${coreVersion}).`,
)
