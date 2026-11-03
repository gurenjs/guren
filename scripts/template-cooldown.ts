/**
 * The release-age gate the scaffold templates ship (RFC 0039 §2): one generated
 * `bunfig.toml` per template, and the release-time check that every third-party
 * range a fresh scaffold resolves still admits a version older than the gate.
 * Bun 1.4.4 fails an install whose range only young versions satisfy, applies the
 * gate to transitive packages, and ignores a scope pattern in the exclusions
 * (measured in RFC 0039 §2), so `@guren/*` is excluded name by name.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectLocalPackages, type DependencyManifest } from './smoke/local-packages'

/** 3 days; RFC 0039 Open Question 2 is whether this becomes 7. */
export const RELEASE_AGE_SECONDS = 259_200

export const TEMPLATE_BUNFIG = 'bunfig.toml'

/** The scaffold's `bunfig.toml`, byte for byte; `sync:template-deps` writes it and `--check` compares. */
export function renderTemplateBunfig(excludes: readonly string[]): string {
  const entries = excludes.map((name) => `  ${JSON.stringify(name)},`).join('\n')
  return `# Bun skips package versions published less than minimumReleaseAge seconds
# ago (3 days), so a compromised release has time to be found and pulled before
# an install here picks it up. To take a fix that is newer than that, add its
# exact version to the list below, for example "some-package@1.2.4".
# The @guren packages are listed by name because Bun does not read "@guren/*",
# and each release of this app's scaffold asks for the versions it shipped with.
[install]
minimumReleaseAge = ${RELEASE_AGE_SECONDS}
minimumReleaseAgeExcludes = [
${entries}
]
`
}

/** The `@guren/*` packages a scaffold installs, which the gate exempts. */
export async function cooldownExclusions(): Promise<string[]> {
  return (await collectLocalPackages()).map((pkg) => pkg.name)
}

export interface ResolvedRange {
  name: string
  range: string
  /** Where the range is declared, for the report. */
  source: string
}

/**
 * Every third-party range a fresh scaffold resolves at the top of its tree: the
 * templates' own, and the dependencies and required peers of each `@guren/*`
 * package the gate exempts (the gate still applies to what those depend on).
 * Deeper ranges are left to `smoke:starter:npm`, which installs from the registry.
 */
export async function scaffoldThirdPartyRanges(templates: readonly string[]): Promise<ResolvedRange[]> {
  const ranges: ResolvedRange[] = []
  const add = (manifest: DependencyManifest, groups: readonly (keyof DependencyManifest)[], source: string, skipOptionalPeers: boolean) => {
    const optional = manifest.peerDependenciesMeta ?? {}
    for (const group of groups) {
      for (const [name, range] of Object.entries((manifest[group] ?? {}) as Record<string, string>)) {
        if (name.startsWith('@guren/')) continue
        if (skipOptionalPeers && group === 'peerDependencies' && optional[name]?.optional === true) continue
        ranges.push({ name, range, source })
      }
    }
  }
  for (const path of templates) {
    add(JSON.parse(await readFile(path, 'utf8')) as DependencyManifest, ['dependencies', 'devDependencies'], path, false)
  }
  for (const pkg of await collectLocalPackages()) {
    const manifest = JSON.parse(await readFile(join(pkg.sourceDir, 'package.json'), 'utf8')) as DependencyManifest
    add(manifest, ['dependencies', 'peerDependencies'], pkg.name, true)
  }
  return ranges
}

export interface Packument {
  versions?: Record<string, unknown>
  time?: Record<string, string>
}

export type FetchPackument = (name: string) => Promise<Packument>

export interface YoungRange extends ResolvedRange {
  reason: string
}

/**
 * The ranges a scaffold could not install under the gate at `now`: every version
 * they admit is younger than the gate, none is admitted, or the registry could not
 * say. A range that is not semver (a tag, a URL) cannot be judged, so it is reported
 * too rather than passed.
 */
export async function youngRanges(ranges: readonly ResolvedRange[], fetchPackument: FetchPackument, now: number): Promise<YoungRange[]> {
  const packuments = new Map<string, Promise<Packument>>()
  const young: YoungRange[] = []
  for (const entry of ranges) {
    // A location (`npm:`, `file:`, a URL or path) or a dist-tag such as `latest`.
    if (/[:/]/u.test(entry.range) || /^[A-Za-z]+$/u.test(entry.range.trim())) {
      young.push({ ...entry, reason: `${entry.range} is not a semver range this check can judge` })
      continue
    }
    let packument: Packument
    try {
      packuments.set(entry.name, packuments.get(entry.name) ?? fetchPackument(entry.name))
      packument = await packuments.get(entry.name)!
    } catch (error) {
      young.push({ ...entry, reason: `the registry did not answer (${error instanceof Error ? error.message : String(error)})` })
      continue
    }
    const admitted = Object.keys(packument.versions ?? {}).filter((version) => Bun.semver.satisfies(version, entry.range))
    if (admitted.length === 0) {
      young.push({ ...entry, reason: 'no published version satisfies it' })
      continue
    }
    const published = admitted.map((version) => ({ version, at: Date.parse(packument.time?.[version] ?? '') }))
    if (published.some(({ at }) => Number.isFinite(at) && now - at >= RELEASE_AGE_SECONDS * 1000)) continue
    const oldest = published.filter(({ at }) => Number.isFinite(at)).sort((a, b) => a.at - b.at)[0]
    young.push({
      ...entry,
      reason: oldest
        ? `the oldest version it admits, ${oldest.version}, was published ${new Date(oldest.at).toISOString()} and clears the gate at ${new Date(oldest.at + RELEASE_AGE_SECONDS * 1000).toISOString()}`
        : 'the registry gives no publish time for the versions it admits',
    })
  }
  return young
}

export async function fetchNpmPackument(name: string): Promise<Packument> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`npm answered ${response.status}`)
  return await response.json() as Packument
}
