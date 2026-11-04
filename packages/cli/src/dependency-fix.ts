/**
 * The fix an advisory proposes (RFC 0039 §5), from the npm registry's packuments:
 * the lowest release of the package outside every affected range for a direct
 * instance, else the lowest release of each path's direct dependency whose tree,
 * resolving each hop to its newest match, lands outside every range, else an
 * override. A proposal is a `candidate`; `dependency-fix-verify.ts` resolves it
 * with Bun before anything calls it `verified`.
 */
import type { DependencyAdvisory } from './audit-deps'
import { inRange } from './dependency-advisory-exposure'
import type { ExposedPackage } from './dependency-exposure'

export type FixStep =
  | { kind: 'update'; package: string; to: string }
  | { kind: 'override'; package: string; to: string; note: string }
  | { kind: 'cooldown-exclude'; entry: string; publishedAt: string }

export interface DependencyFix {
  status: 'verified' | 'candidate' | 'unavailable'
  reason?: string
  steps: FixStep[]
}

export interface Packument {
  versions: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; deprecated?: unknown }>
  time?: Record<string, string>
}

/** `null` when the registry has no such package or did not answer; the caller's reason says which. */
export type PackumentReader = (name: string) => Promise<Packument | null>

export const OVERRIDE_NOTE = 'Bun\'s overrides replace the range every dependent asks for, and do not move a peer the lockfile has already resolved.'

/** How many releases of a direct dependency are tried for a path before falling back to an override. */
const MAX_HEAD_CANDIDATES = 40

function isStable(version: string): boolean {
  return !version.includes('-')
}

function major(version: string): string {
  return version.split('.')[0] ?? ''
}

/** `Bun.semver.order` throws on a version that is not semver, such as a `file:` dependency's. */
function isSemver(version: string): boolean {
  try {
    Bun.semver.order(version, '0.0.0')
    return true
  } catch {
    return false
  }
}

function ascending(versions: string[]): string[] {
  return versions.filter(isSemver).sort((a, b) => Bun.semver.order(a, b))
}

/** Releases newer than `from`, stable unless `from` is a prerelease, not deprecated, oldest first; none for a `from` that is not semver. */
function newerReleases(packument: Packument, from: string): string[] {
  if (!isSemver(from)) return []
  return ascending(Object.keys(packument.versions)).filter((version) =>
    Bun.semver.order(version, from) > 0
    && (isStable(version) || !isStable(from))
    && packument.versions[version]?.deprecated === undefined)
}

/** The lowest release past `from` outside every range, in `from`'s major when one exists. */
export function lowestFixed(packument: Packument, from: string, ranges: readonly string[]): string | null {
  const fixed = newerReleases(packument, from).filter((version) => !inRange(version, ranges))
  return fixed.find((version) => major(version) === major(from)) ?? fixed[0] ?? null
}

function newestMatching(packument: Packument, range: string): string | null {
  const matches = Object.keys(packument.versions).filter((version) => {
    try {
      return Bun.semver.satisfies(version, range)
    } catch {
      return false
    }
  })
  return matches.length === 0 ? null : ascending(matches).at(-1)!
}

/**
 * What `chain` resolves to from `head@version`, each hop taking its newest match:
 * `fixed` once the vulnerable package is outside `ranges` or a hop has dropped the
 * next package, `unknown` when a packument or a version is missing on the way.
 */
async function chainOutcome(chain: string[], version: string, ranges: readonly string[], read: PackumentReader): Promise<'fixed' | 'affected' | 'unknown'> {
  let current = version
  for (let hop = 0; hop < chain.length - 1; hop += 1) {
    const packument = await read(chain[hop]!)
    const manifest = packument?.versions[current]
    if (!manifest) return 'unknown'
    const range = manifest.dependencies?.[chain[hop + 1]!] ?? manifest.optionalDependencies?.[chain[hop + 1]!]
    if (range === undefined) return 'fixed'
    const next = await read(chain[hop + 1]!)
    if (!next) return 'unknown'
    const resolved = newestMatching(next, range)
    if (resolved === null) return 'unknown'
    current = resolved
  }
  return inRange(current, ranges) ? 'affected' : 'fixed'
}

export interface ProposeInput {
  advisory: DependencyAdvisory
  exposures: readonly ExposedPackage[]
  /** Every instance the exposure document holds, for the installed version of a path's direct dependency. */
  installed: readonly ExposedPackage[]
  read: PackumentReader
  /** Epoch ms after which no further release of a path's direct dependency is tried. */
  deadline?: number
}

export async function proposeFix({ advisory, exposures, installed, read, deadline }: ProposeInput): Promise<DependencyFix> {
  const { package: name, ranges } = advisory
  if (exposures.length === 0) return { status: 'unavailable', reason: `No installed instance of ${name} is inside the advisory's ranges.`, steps: [] }
  const packument = await read(name)
  if (!packument) return { status: 'unavailable', reason: `The registry did not answer for ${name}.`, steps: [] }

  const steps = new Map<string, FixStep>()
  const reasons: string[] = []
  const override = (instance: ExposedPackage): void => {
    const to = lowestFixed(packument, instance.version, ranges)
    if (to === null) reasons.push(`No release of ${name} after ${instance.version} is outside ${ranges.join(' || ')}.`)
    else steps.set(`override:${name}`, { kind: 'override', package: name, to, note: OVERRIDE_NOTE })
  }

  for (const instance of exposures) {
    if (instance.direct) {
      const to = lowestFixed(packument, instance.version, ranges)
      if (to === null) reasons.push(`No release of ${name} after ${instance.version} is outside ${ranges.join(' || ')}.`)
      else steps.set(`update:${name}`, { kind: 'update', package: name, to })
    }
    for (const [head, chain] of Object.entries(instance.paths)) {
      if (chain.length < 2) continue
      const current = installed.find((entry) => entry.direct && entry.installedAs.includes(head))
      const headPackument = current ? await read(current.name) : null
      if (!current || !headPackument) {
        reasons.push(`The registry did not answer for ${head}, so no update along ${chain.join(' > ')} was tried.`)
        override(instance)
        continue
      }
      let to: string | null = null
      for (const version of newerReleases(headPackument, current.version).slice(0, MAX_HEAD_CANDIDATES)) {
        if (deadline !== undefined && Date.now() > deadline) {
          reasons.push(`The fix search ran out of its time budget while trying releases of ${head}.`)
          break
        }
        if (await chainOutcome([current.name, ...chain.slice(1)], version, ranges, read) === 'fixed') {
          to = version
          break
        }
      }
      if (to === null) override(instance)
      else steps.set(`update:${head}`, { kind: 'update', package: head, to })
    }
  }

  if (steps.has(`override:${name}`)) {
    for (const key of steps.keys()) if (key !== `override:${name}` && key !== `update:${name}`) steps.delete(key)
  }
  const proposed = [...steps.values()]
  if (proposed.length === 0) return { status: 'unavailable', reason: reasons.join(' ') || `No fix for ${name} was found.`, steps: [] }
  return { status: 'candidate', ...(reasons.length > 0 ? { reason: reasons.join(' ') } : {}), steps: proposed }
}

const REGISTRY = 'https://registry.npmjs.org'
const PACKUMENT_TIMEOUT_MS = 10_000

/** Full packuments (the abbreviated form has no publish times), one fetch per name per run. */
export function registryPackuments(registry = process.env.BUN_CONFIG_REGISTRY || process.env.NPM_CONFIG_REGISTRY || REGISTRY): PackumentReader {
  const cache = new Map<string, Promise<Packument | null>>()
  const base = registry.replace(/\/+$/u, '')
  return (name) => {
    let hit = cache.get(name)
    if (!hit) {
      hit = fetch(`${base}/${name.replace('/', '%2f')}`, { signal: AbortSignal.timeout(PACKUMENT_TIMEOUT_MS) })
        .then(async (response) => {
          if (!response.ok) return null
          const body = (await response.json()) as Packument
          return typeof body?.versions === 'object' && body.versions !== null ? body : null
        })
        .catch(() => null)
      cache.set(name, hit)
    }
    return hit
  }
}
