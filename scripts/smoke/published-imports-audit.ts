// oxlint-disable-next-line guren/comment-length -- the scope, the blind spots and the exit contract are each one line a reader of a red run needs
/**
 * Fail a pending `@guren/*` release that drops an export name a first-party package
 * already on npm still imports, through a range admitting that release: an app
 * updating the dependency beside the old dependent then fails to link. The inverse of
 * `audit:import-floors`, which holds a floor to what current source imports.
 * Reads each release line's latest tarball (`dist/**.js`, roots and subpaths) against
 * the releasing package's working-tree source. Blind to type-only names (`.d.ts`), to
 * an import through an undeclared range, and to a changed *value*: a renamed table
 * key the old dependent looks up links fine and misbehaves. Exit 1 drift, 2 cannot run.
 */
import { join } from 'node:path'
import process from 'node:process'
import { readChangesetDirectory } from './core-semver-audit'
import { DEPENDENCY_GROUPS, plannedVersions } from './plugin-compat-audit'
import {
  CannotJudge,
  importSites,
  missingFrom,
  Repository,
  SurfaceReader,
  type Requirement,
  type Surface,
} from '../sync-import-floors'
import { collectPackages, repoRoot } from '../workspace-packages'

const REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 30_000
const RUNTIME_FILE = /\.m?js$/

export interface PublishedRelease {
  name: string
  version: string
  /** `dependencies` then `peerDependencies`, as the registry reports them for this version. */
  ranges: Partial<Record<(typeof DEPENDENCY_GROUPS)[number], Record<string, string>>>
  files: Array<{ path: string; source: string }>
}

export interface PendingRelease {
  name: string
  version: string
}

export interface PublishedImportsResult {
  failures: string[]
  pairsChecked: number
}

/** Over already-fetched tarball text, so fixtures can exercise it without a registry. */
export function judgePublishedImports(
  published: readonly PublishedRelease[],
  releasing: readonly PendingRelease[],
  surfaceAt: (pkg: string, subpath: string) => Surface,
): PublishedImportsResult {
  const failures: string[] = []
  let pairsChecked = 0

  for (const dependent of published) {
    const byDependency = new Map<string, Map<string, Requirement>>()
    for (const file of dependent.files) {
      for (const site of importSites(file.source, `${dependent.name}@${dependent.version}/${file.path}`)) {
        if (site.dependency === dependent.name) continue
        const requirements = byDependency.get(site.dependency) ?? new Map<string, Requirement>()
        byDependency.set(site.dependency, requirements)
        const requirement = requirements.get(site.subpath) ?? { subpath: site.subpath, names: new Set(), files: new Set() }
        requirements.set(site.subpath, requirement)
        for (const name of site.names) requirement.names.add(name)
        requirement.files.add(file.path)
      }
    }

    for (const release of releasing) {
      const requirements = byDependency.get(release.name)
      if (!requirements) continue
      const admitting = DEPENDENCY_GROUPS.flatMap((group) => {
        const range = dependent.ranges[group]?.[release.name]
        return range !== undefined && Bun.semver.satisfies(release.version, range) ? [{ group, range }] : []
      })[0]
      if (!admitting) continue
      pairsChecked += 1

      const gaps = missingFrom(
        (subpath) => surfaceAt(release.name, subpath),
        `${release.name} ${release.version}`,
        [...requirements.values()],
      )
      for (const gap of gaps) {
        const specifier = `${release.name}${gap.requirement.subpath.slice(1)}`
        failures.push(
          `${dependent.name}@${dependent.version} imports ${specifier} (${[...gap.requirement.files].sort().join(', ')}), ` +
            `and ${release.name} ${release.version} ships ${gap.text.replace(gap.requirement.subpath, specifier)}. Its ${admitting.group}["${release.name}"] is "${admitting.range}", which admits ` +
            `${release.version}, so an app updating ${release.name} beside it fails to link. Keep the ` +
            'name exported (deprecated) until no admitting published release imports it.',
        )
      }
    }
  }

  return { failures, pairsChecked }
}

/** Regular files of a `.tgz`, as text. Handles the ustar `prefix` field and pax `path` records. */
export function readTarball(gzipped: Uint8Array): Array<{ path: string; source: string }> {
  const tar = Bun.gunzipSync(gzipped)
  const decoder = new TextDecoder()
  const field = (header: Uint8Array, start: number, end: number): string =>
    decoder.decode(header.subarray(start, end)).replace(/\0[\s\S]*$/, '')

  const entries: Array<{ path: string; source: string }> = []
  let paxPath: string | undefined
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(field(header, 124, 136).trim() || '0', 8)
    if (!Number.isFinite(size)) throw new CannotJudge(`Unreadable tar header at byte ${offset}.`)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    const type = field(header, 156, 157)
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(body))?.[1]
      continue
    }
    if (type === 'g') continue
    if (type === '0' || type === '') {
      const name = field(header, 0, 100)
      const prefix = field(header, 345, 500)
      entries.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), source: decoder.decode(body) })
    }
    paxPath = undefined
  }
  return entries
}

interface Packument {
  'dist-tags'?: Record<string, string>
  versions?: Record<
    string,
    {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      dist?: { tarball?: string }
    }
  >
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

async function fetchOk(fetch: Fetch, url: string): Promise<Response | null> {
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (response.status === 404) return null
      if (response.ok) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new CannotJudge(`${url} could not be read from the registry (${lastError}).`)
}

/** `null` when the package was never published: there is no copy on npm to break. */
async function fetchPackument(fetch: Fetch, name: string): Promise<Packument | null> {
  const response = await fetchOk(fetch, `${REGISTRY}/${name.replace('/', '%2f')}`)
  if (!response) return null
  try {
    return (await response.json()) as Packument
  } catch {
    throw new CannotJudge(`The registry answered ${name} with a body that is not JSON.`)
  }
}

/** The newest stable version of each line a caret resolves within: the major, or the minor below 1.0.0. */
export function releaseLineHeads(versions: readonly string[]): string[] {
  const heads = new Map<string, string>()
  for (const version of versions) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (!match) continue
    const line = match[1] === '0' ? `0.${match[2]}` : match[1]!
    const head = heads.get(line)
    if (!head || Bun.semver.order(version, head) > 0) heads.set(line, version)
  }
  return [...heads.values()].sort(Bun.semver.order)
}

export async function run(
  options: { root?: string; fetch?: Fetch } = {},
): Promise<{ code: 0 | 1 | 2; messages: string[] }> {
  const root = options.root ?? repoRoot
  const fetch = options.fetch ?? globalThis.fetch
  try {
    const workspace = (await collectPackages(root)).filter((pkg) => !pkg.private)
    const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]))
    const versions = new Map(workspace.flatMap((pkg) => (pkg.version ? [[pkg.name, pkg.version] as const] : [])))
    // An unreadable plan must not read as "releases nothing", which passes every removal.
    const changesets = await readChangesetDirectory(join(root, '.changeset')).catch((cause: unknown) => {
      throw new CannotJudge(cause instanceof Error ? cause.message : String(cause))
    })
    const planned = plannedVersions(versions, changesets)

    const packuments = new Map(
      await Promise.all(workspace.map(async (pkg) => [pkg.name, await fetchPackument(fetch, pkg.name)] as const)),
    )

    // After `changeset version` the plan is consumed, and the release is the workspace version npm lacks.
    const releasing: PendingRelease[] = []
    for (const pkg of workspace) {
      const latest = packuments.get(pkg.name)?.['dist-tags']?.latest
      const version = planned.get(pkg.name) ?? (latest && pkg.version && Bun.semver.order(pkg.version, latest) > 0 ? pkg.version : undefined)
      if (version) releasing.push({ name: pkg.name, version })
    }
    if (releasing.length === 0) {
      return { code: 0, messages: ['Published imports audit: no pending @guren/* release, nothing to judge.'] }
    }

    const candidates: Array<{ name: string; version: string; tarball: string; ranges: PublishedRelease['ranges'] }> = []
    let unpublished = 0
    for (const pkg of workspace) {
      const packument = packuments.get(pkg.name)
      if (!packument) {
        unpublished += 1
        continue
      }
      for (const version of releaseLineHeads(Object.keys(packument.versions ?? {}))) {
        const meta = packument.versions![version]!
        const ranges = { dependencies: meta.dependencies, peerDependencies: meta.peerDependencies }
        const admits = releasing.some((release) =>
          DEPENDENCY_GROUPS.some((group) => {
            const range = ranges[group]?.[release.name]
            return range !== undefined && Bun.semver.satisfies(release.version, range)
          }),
        )
        if (!admits) continue
        if (!meta.dist?.tarball) throw new CannotJudge(`The registry lists no tarball for ${pkg.name}@${version}.`)
        candidates.push({ name: pkg.name, version, tarball: meta.dist.tarball, ranges })
      }
    }

    const published = await Promise.all(
      candidates.map(async (candidate): Promise<PublishedRelease> => {
        const response = await fetchOk(fetch, candidate.tarball)
        if (!response) throw new CannotJudge(`${candidate.tarball} is listed by the registry but answers 404.`)
        let entries: Array<{ path: string; source: string }>
        try {
          entries = readTarball(new Uint8Array(await response.arrayBuffer()))
        } catch (error) {
          if (error instanceof CannotJudge) throw error
          throw new CannotJudge(`${candidate.tarball} is not a readable gzipped tarball: ${String(error)}`)
        }
        return {
          name: candidate.name,
          version: candidate.version,
          ranges: candidate.ranges,
          files: entries.filter((entry) => RUNTIME_FILE.test(entry.path) && entry.source.includes('@guren/')),
        }
      }),
    )

    const reader = new SurfaceReader(new Repository(root), byName, 'working-tree')
    const { failures, pairsChecked } = judgePublishedImports(published, releasing, (name, subpath) => {
      const pkg = byName.get(name)!
      return reader.surface(pkg, { version: pkg.version ?? '', rev: null }, subpath)
    })

    const summary =
      `${pairsChecked} published release(s) admitting ${releasing.map((r) => `${r.name} ${r.version}`).join(', ')}` +
      ` (${unpublished} workspace package(s) not on npm)`
    if (failures.length > 0) {
      return { code: 1, messages: [...failures, `Published imports audit failed: ${failures.length} missing import(s) across ${summary}.`] }
    }
    return { code: 0, messages: [`Published imports audit passed: ${summary}.`] }
  } catch (error) {
    if (!(error instanceof CannotJudge)) throw error
    return { code: 2, messages: ['Published imports audit could not run.', error.message] }
  }
}

if (import.meta.main) {
  const result = await run()
  const log = result.code === 0 ? console.log : console.error
  for (const message of result.messages) log(message)
  process.exit(result.code)
}
