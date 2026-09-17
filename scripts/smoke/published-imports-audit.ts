// oxlint-disable-next-line guren/comment-length -- the scope, the blind spots and the exit contract are each one line a reader of a red run needs
/**
 * Fail a pending `@guren/*` release that drops an export name a first-party package
 * already on npm still imports, through a range admitting that release: an app
 * updating the dependency beside the old dependent then fails to link. The inverse of
 * `audit:import-floors`, which holds a floor to what current source imports.
 * Reads each release line's latest tarball (`dist/**.js`, roots and subpaths) against
 * the releasing package's working-tree source, before `changeset version` consumes the
 * plan. Blind to type-only names (`.d.ts`), to an import through an undeclared range,
 * and to a changed *value*: a renamed table key links fine and misbehaves.
 * Exit 1 drift, 2 cannot run.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { readChangesetDirectory } from './core-semver-audit'
import { DEPENDENCY_GROUPS, plannedVersions } from './plugin-compat-audit'
import { CannotJudge, groupRequirements, missingFrom, Repository, SurfaceReader, type Surface } from '../sync-import-floors'
import { collectPackages, repoRoot } from '../workspace-packages'

const REGISTRY = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 30_000

type Ranges = Partial<Record<(typeof DEPENDENCY_GROUPS)[number], Record<string, string>>>

export interface PublishedRelease {
  name: string
  version: string
  /** `dependencies` and `peerDependencies`, as the registry reports them for this version. */
  ranges: Ranges
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

/** The first group whose range for `release` admits its version; the candidate filter and the judge must agree. */
function admittingRange(ranges: Ranges, release: PendingRelease): { group: string; range: string } | undefined {
  for (const group of DEPENDENCY_GROUPS) {
    const range = ranges[group]?.[release.name]
    if (range !== undefined && Bun.semver.satisfies(release.version, range)) return { group, range }
  }
  return undefined
}

/** Over already-read tarball text, so fixtures can exercise it without a registry. */
export function judgePublishedImports(
  published: readonly PublishedRelease[],
  releasing: readonly PendingRelease[],
  surfaceAt: (pkg: string, subpath: string) => Surface,
): PublishedImportsResult {
  const failures: string[] = []
  let pairsChecked = 0

  for (const dependent of published) {
    const byDependency = groupRequirements(dependent.name, dependent.files)
    for (const release of releasing) {
      const requirements = byDependency.get(release.name)
      const admitting = requirements && admittingRange(dependent.ranges, release)
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
            `and ${release.name} ${release.version} ships ${gap.text.replace(gap.requirement.subpath, specifier)}. Its ` +
            `${admitting.group}["${release.name}"] is "${admitting.range}", which admits ` +
            `${release.version}, so an app updating ${release.name} beside it fails to link. Keep the ` +
            'name exported (deprecated) until no admitting published release imports it.',
        )
      }
    }
  }

  return { failures, pairsChecked }
}

interface Packument {
  versions?: Record<string, { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; dist?: { tarball?: string } }>
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

async function fetchOk(fetch: Fetch, url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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
  const response = await fetchOk(fetch, `${REGISTRY}/${encodeURIComponent(name)}`, {
    // The abbreviated packument: versions, their ranges and tarballs, without readmes.
    accept: 'application/vnd.npm.install-v1+json',
  })
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

/** Unpacked with the system `tar`, which reads every long-path form an in-house parser would have to get right. */
async function readPublished(
  fetch: Fetch,
  candidate: Omit<PublishedRelease, 'files'> & { tarball: string },
  scratch: string,
): Promise<PublishedRelease> {
  const response = await fetchOk(fetch, candidate.tarball)
  if (!response) throw new CannotJudge(`${candidate.tarball} is listed by the registry but answers 404.`)
  const dir = join(scratch, `${candidate.name.replaceAll('/', '__')}@${candidate.version}`)
  const archive = `${dir}.tgz`
  await Bun.write(archive, await response.arrayBuffer())
  await mkdir(dir, { recursive: true })
  const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', dir])
  if (!tar.success) throw new CannotJudge(`${candidate.tarball} did not unpack: ${tar.stderr.toString().trim()}`)

  const files: PublishedRelease['files'] = []
  for await (const path of new Bun.Glob('**/*.{js,mjs}').scan({ cwd: dir })) {
    const source = await Bun.file(join(dir, path)).text()
    if (source.includes('@guren/')) files.push({ path, source })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { name: candidate.name, version: candidate.version, ranges: candidate.ranges, files }
}

export async function run(
  options: { root?: string; fetch?: Fetch } = {},
): Promise<{ code: 0 | 1 | 2; messages: string[] }> {
  const root = options.root ?? repoRoot
  const fetch = options.fetch ?? globalThis.fetch
  const scratch = await mkdtemp(join(tmpdir(), 'guren-published-imports-'))
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

    const releasing = [...planned].map(([name, version]) => ({ name, version }))
    if (releasing.length === 0) {
      return { code: 0, messages: ['Published imports audit: no pending @guren/* release, nothing to judge.'] }
    }

    const candidates: Array<Omit<PublishedRelease, 'files'> & { tarball: string }> = []
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
        if (!releasing.some((release) => admittingRange(ranges, release))) continue
        if (!meta.dist?.tarball) throw new CannotJudge(`The registry lists no tarball for ${pkg.name}@${version}.`)
        candidates.push({ name: pkg.name, version, tarball: meta.dist.tarball, ranges })
      }
    }

    const published = await Promise.all(candidates.map((candidate) => readPublished(fetch, candidate, scratch)))

    const reader = new SurfaceReader(new Repository(root), byName, 'working-tree')
    const { failures, pairsChecked } = judgePublishedImports(published, releasing, (name, subpath) => {
      const pkg = byName.get(name)!
      return reader.surface(pkg, { version: pkg.version ?? '', rev: null }, subpath)
    })

    const summary =
      `${published.length} published release(s), ${pairsChecked} pair(s) with a pending release among ${releasing.map((r) => `${r.name} ${r.version}`).join(', ')}` +
      ` (${unpublished} workspace package(s) not on npm)`
    if (failures.length > 0) {
      return { code: 1, messages: [...failures, `Published imports audit failed: ${failures.length} missing import(s) across ${summary}.`] }
    }
    return { code: 0, messages: [`Published imports audit passed: ${summary}.`] }
  } catch (error) {
    if (!(error instanceof CannotJudge)) throw error
    return { code: 2, messages: ['Published imports audit could not run.', error.message] }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const result = await run()
  const log = result.code === 0 ? console.log : console.error
  for (const message of result.messages) log(message)
  process.exit(result.code)
}
