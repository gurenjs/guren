/**
 * The release-age gate the scaffold templates ship (RFC 0039 §2): one generated
 * `bunfig.toml` per template, rendered by `packages/cli/src/release-age.ts` (the
 * block `guren upgrade` writes too), and the release check that every third-party range
 * a fresh scaffold or a `guren add` resolves still admits a version older than the
 * gate. Bun 1.4.4 fails an install whose range only young versions satisfy, applies
 * the gate to transitive packages, and ignores a scope pattern in the exclusions
 * (measured in RFC 0039 §2), so `@guren/*` is excluded name by name.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AI_PROVIDERS } from '../packages/cli/src/add-ai'
import { RELEASE_AGE_SECONDS } from '../packages/cli/src/release-age'
import { DATABASE_DEFAULTS } from '../packages/create-app/src/blueprints'
import { collectLocalPackages, type DependencyManifest } from './smoke/local-packages'
import { collectPackages, repoRoot } from './workspace-packages'

/**
 * Every `@guren/*` package this workspace publishes, not only the ones a scaffold
 * installs: an app adds plugins later (`guren add ai`, `guren plugin`), and a
 * release can make a scaffolded package depend on one the scaffold never had.
 */
export async function cooldownExclusions(): Promise<string[]> {
  return (await collectPackages())
    .filter((pkg) => pkg.name.startsWith('@guren/') && pkg.version && !pkg.private)
    .map((pkg) => pkg.name)
    .sort((a, b) => a.localeCompare(b))
}

export interface ResolvedRange {
  name: string
  range: string
  /** Where the range is declared, for the report. */
  source: string
}

async function readManifest(path: string): Promise<DependencyManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as DependencyManifest
}

/**
 * The third-party ranges a scaffolded app asks Bun to resolve at the top of its
 * tree: the templates' own, the driver `create-guren-app --db` adds, what `guren add
 * ai` pins from the CLI's devDependencies, and the dependencies and required peers
 * of each `@guren/*` package a scaffold installs (the gate still applies to those).
 * Deeper ranges are left to `smoke:starter:npm`, which installs from the registry.
 */
export async function scaffoldThirdPartyRanges(templates: readonly string[]): Promise<ResolvedRange[]> {
  const ranges: ResolvedRange[] = []
  const add = (dependencies: Record<string, string> | undefined, source: string, skip: (name: string) => boolean = () => false) => {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      if (!name.startsWith('@guren/') && !skip(name)) ranges.push({ name, range, source })
    }
  }
  for (const path of templates) {
    const manifest = await readManifest(path)
    add(manifest.dependencies, path)
    add(manifest.devDependencies, path)
  }
  for (const [driver, { dep }] of Object.entries(DATABASE_DEFAULTS)) {
    add(dep ?? undefined, `create-guren-app --db ${driver}`)
  }
  const cli = await readManifest(join(repoRoot, 'packages/cli/package.json'))
  for (const name of ['ai', ...Object.values(AI_PROVIDERS).flatMap((provider) => provider.package ? [provider.package] : [])]) {
    const range = cli.devDependencies?.[name]
    if (range === undefined) throw new Error(`packages/cli/package.json declares no devDependency on ${name}, which guren add ai installs at that range.`)
    ranges.push({ name, range, source: 'guren add ai' })
  }
  for (const pkg of await collectLocalPackages()) {
    const manifest = await readManifest(join(pkg.sourceDir, 'package.json'))
    const optional = manifest.peerDependenciesMeta ?? {}
    add(manifest.dependencies, pkg.name)
    add(manifest.peerDependencies, pkg.name, (name) => optional[name]?.optional === true)
  }
  return ranges
}

export interface Packument {
  versions?: Record<string, unknown>
  time?: Record<string, string>
  'dist-tags'?: Record<string, string>
}

export type FetchPackument = (name: string) => Promise<Packument>

export interface YoungRange extends ResolvedRange {
  reason: string
}

const COMPARATOR = /^(?:[<>]=?|=|\^|~)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * `Bun.semver.satisfies()` reads a string that is no range (`next-15`, `beta2`) as
 * matching every version, so a range is judged only when each comparator of each
 * `||` alternative parses; a hyphen range's `-` stands alone between two versions.
 */
export function isSemverRange(range: string): boolean {
  return range.split('||').every((alternative) => {
    const tokens = alternative.trim().split(/\s+/u).filter(Boolean)
    if (tokens.length === 0) return true
    if (tokens.length === 3 && tokens[1] === '-') return COMPARATOR.test(tokens[0]!) && COMPARATOR.test(tokens[2]!)
    return tokens.every((token) => COMPARATOR.test(token))
  })
}

/**
 * The ranges a scaffold could not install under the gate at `now`: every version
 * they admit is younger than the gate, none is admitted, the registry could not
 * say, or the specifier is neither a range nor a dist-tag the packument names. A
 * version with no publish time passes, as Bun lets it through.
 */
export async function youngRanges(ranges: readonly ResolvedRange[], fetchPackument: FetchPackument, now: number): Promise<YoungRange[]> {
  const packuments = new Map<string, Promise<Packument>>()
  const young: YoungRange[] = []
  for (const entry of ranges) {
    if (/[:/]/u.test(entry.range)) {
      young.push({ ...entry, reason: `${entry.range} names a location, which this check cannot judge` })
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
    const tagged = packument['dist-tags']?.[entry.range.trim()]
    if (tagged === undefined && !isSemverRange(entry.range)) {
      young.push({ ...entry, reason: `${entry.range} is neither a semver range nor a dist-tag of ${entry.name}` })
      continue
    }
    const admitted = tagged !== undefined
      ? [tagged]
      : Object.keys(packument.versions ?? {}).filter((version) => Bun.semver.satisfies(version, entry.range))
    if (admitted.length === 0) {
      young.push({ ...entry, reason: 'no published version satisfies it' })
      continue
    }
    const published = admitted.map((version) => ({ version, at: Date.parse(packument.time?.[version] ?? '') }))
    if (published.some(({ at }) => !Number.isFinite(at) || now - at >= RELEASE_AGE_SECONDS * 1000)) continue
    const oldest = published.sort((a, b) => a.at - b.at)[0]!
    young.push({
      ...entry,
      reason: `the oldest version it admits, ${oldest.version}, was published ${new Date(oldest.at).toISOString()} and clears the gate at ${new Date(oldest.at + RELEASE_AGE_SECONDS * 1000).toISOString()}`,
    })
  }
  return young
}

export async function fetchNpmPackument(name: string): Promise<Packument> {
  const response = await fetch(`https://registry.npmjs.org/${name.replaceAll('/', '%2f')}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`npm answered ${response.status}`)
  return await response.json() as Packument
}
