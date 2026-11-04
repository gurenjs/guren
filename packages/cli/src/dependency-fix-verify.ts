/**
 * The check that turns a proposed fix into a verified one (RFC 0039 §5): the
 * app's manifest, lockfile and `bunfig.toml` are copied to a temporary directory,
 * the steps applied, and `bun install --lockfile-only` resolves there under the
 * app's own release-age gate. A version the gate blocks becomes a
 * `cooldown-exclude` step and the resolution runs again. Measured on Bun 1.4.4:
 * `--lockfile-only` applies the gate to transitive packages and writes no `node_modules`.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DependencyAdvisory } from './audit-deps'
import { inRange } from './dependency-advisory-exposure'
import type { DependencyFix, FixStep, Packument, PackumentReader } from './dependency-fix'
import { dependencyTree, readBunLock } from './dependency-tree'
import { addExclusions, BUNFIG_FILE, readReleaseAge } from './release-age'

export interface ResolveResult {
  exitCode: number
  stderr: string
}

/** Runs `bun install --lockfile-only` in `dir`; a seam so the loop is tested without the registry. */
export type LockfileResolver = (dir: string) => Promise<ResolveResult>

const MANIFEST_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const RESOLVE_TIMEOUT_MS = 60_000
const MAX_ROUNDS = 4
/** Bun 1.4.4: `No version matching "^3.11.0" found for specifier "@inertiajs/react" (blocked by minimum-release-age: 259200 seconds)`. */
const BLOCKED = /No version matching "([^"]+)" found for specifier "([^"]+)" \(blocked by minimum-release-age/gu

export const runLockfileOnly: LockfileResolver = async (dir) => {
  const proc = Bun.spawn([process.execPath, 'install', '--lockfile-only', '--no-progress'], { cwd: dir, stdout: 'ignore', stderr: 'pipe', timeout: RESOLVE_TIMEOUT_MS })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr as ReadableStream).text(), proc.exited])
  return { exitCode, stderr }
}

type Manifest = Record<string, unknown> & Partial<Record<(typeof MANIFEST_GROUPS)[number], Record<string, string>>> & { overrides?: Record<string, string> }

/** The spec `update` writes: the old one's `^` or `~` kept, anything else pinned. */
function nextSpec(previous: string, to: string): string {
  return previous.startsWith('^') ? `^${to}` : previous.startsWith('~') ? `~${to}` : to
}

function applyManifestSteps(manifest: Manifest, steps: readonly FixStep[]): string | null {
  for (const step of steps) {
    if (step.kind === 'update') {
      const groups = MANIFEST_GROUPS.filter((group) => manifest[group]?.[step.package] !== undefined)
      if (groups.length === 0) return `${step.package} is not declared in package.json, so it cannot be updated there.`
      for (const group of groups) manifest[group]![step.package] = nextSpec(manifest[group]![step.package]!, step.to)
    } else if (step.kind === 'override') {
      manifest.overrides = { ...manifest.overrides, [step.package]: step.to }
    }
  }
  return null
}

/** The bunfig with the steps' exclusions added, or a reason the check cannot add them. */
function applyExclusions(text: string | undefined, entries: readonly string[]): { text?: string; reason?: string } {
  if (entries.length === 0) return { text }
  const reading = readReleaseAge(text)
  if (reading.kind !== 'on' || text === undefined) return { reason: 'a version was blocked although bunfig.toml sets no release-age gate' }
  if (!/^minimumReleaseAgeExcludes\s*=/mu.test(text)) {
    return { text: text.replace(/^(minimumReleaseAge\s*=.*)$/mu, `$1\nminimumReleaseAgeExcludes = [\n${entries.map((entry) => `  ${JSON.stringify(entry)},\n`).join('')}]`) }
  }
  const added = addExclusions(text, entries)
  return added === null ? { reason: 'bunfig.toml lists minimumReleaseAgeExcludes in a shape the check does not edit (one entry per line)' } : { text: added }
}

/** The newest version the gate held back for `spec`, which is what Bun would have taken. */
function blockedVersion(packument: Packument, spec: string, seconds: number, now: number): string | null {
  const young = Object.keys(packument.versions).filter((version) => {
    const published = Date.parse(packument.time?.[version] ?? '')
    try {
      return Number.isFinite(published) && now - published < seconds * 1000 && Bun.semver.satisfies(version, spec)
    } catch {
      return false
    }
  })
  return young.length === 0 ? null : young.sort((a, b) => Bun.semver.order(a, b)).at(-1)!
}

export interface VerifyInput {
  cwd: string
  /** The exposure document's workspace: a workspace app's lockfile holds other workspaces too. */
  workspace: string
  advisory: DependencyAdvisory
  fix: DependencyFix
  read: PackumentReader
  resolve?: LockfileResolver
  now?: number
}

export async function verifyFix(input: VerifyInput): Promise<DependencyFix> {
  const { cwd, advisory, fix, read } = input
  const resolve = input.resolve ?? runLockfileOnly
  const now = input.now ?? Date.now()
  const candidate = (reason: string, steps = fix.steps): DependencyFix => ({ status: 'candidate', reason, steps })
  if (fix.status !== 'candidate') return fix
  if (input.workspace !== '') return candidate('The app shares a workspace lockfile, so the fix is checked only from the workspace root.')

  const manifestText = await readFile(join(cwd, 'package.json'), 'utf8').catch(() => null)
  if (manifestText === null) return candidate('package.json could not be read.')
  const manifest = JSON.parse(manifestText) as Manifest
  if (manifest.workspaces !== undefined || manifest.patchedDependencies !== undefined) {
    return candidate('package.json declares workspaces or patched dependencies, which the check does not copy.')
  }
  const bunfig = await readFile(join(cwd, BUNFIG_FILE), 'utf8').catch(() => undefined)
  const gate = readReleaseAge(bunfig)

  const dir = await mkdtemp(join(tmpdir(), 'guren-deps-fix-'))
  try {
    await copyFile(join(cwd, 'bun.lock'), join(dir, 'bun.lock')).catch(() => undefined)
    await copyFile(join(cwd, '.npmrc'), join(dir, '.npmrc')).catch(() => undefined)
    let steps = [...fix.steps]
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const next = structuredClone(manifest)
      const refused = applyManifestSteps(next, steps)
      if (refused) return candidate(refused, steps)
      const exclusions = applyExclusions(bunfig, steps.flatMap((step) => step.kind === 'cooldown-exclude' ? [step.entry] : []))
      if (exclusions.reason) return candidate(`The check could not add the exclusion: ${exclusions.reason}.`, steps)
      await writeFile(join(dir, 'package.json'), `${JSON.stringify(next, null, 2)}\n`)
      if (exclusions.text !== undefined) await writeFile(join(dir, BUNFIG_FILE), exclusions.text)

      const result = await resolve(dir)
      if (result.exitCode === 0) {
        const reading = readBunLock(await readFile(join(dir, 'bun.lock'), 'utf8').catch(() => ''))
        if (reading.kind !== 'read') return candidate(`The resolved bun.lock could not be read (${reading.reason}).`, steps)
        const still = dependencyTree(reading.lock).packages.filter((instance) => instance.name === advisory.package && inRange(instance.version, advisory.ranges))
        return still.length === 0
          ? { status: 'verified', steps }
          : candidate(`bun install --lockfile-only still resolves ${still.map((instance) => instance.id).join(', ')}.`, steps)
      }

      const blocked = [...result.stderr.matchAll(BLOCKED)]
      if (blocked.length === 0 || gate.kind !== 'on') {
        const last = result.stderr.trim().split('\n').at(-1) ?? `exit ${result.exitCode}`
        return candidate(`bun install --lockfile-only failed: ${last}`, steps)
      }
      const added: FixStep[] = []
      for (const [, spec, name] of blocked) {
        const packument = await read(name!)
        const version = packument ? blockedVersion(packument, spec!, gate.seconds, now) : null
        const publishedAt = version ? packument?.time?.[version] : undefined
        if (!version || !publishedAt) return candidate(`The release-age gate blocked ${name}@${spec}, and its publish time could not be read.`, steps)
        if (!steps.some((step) => step.kind === 'cooldown-exclude' && step.entry === `${name}@${version}`)) added.push({ kind: 'cooldown-exclude', entry: `${name}@${version}`, publishedAt })
      }
      if (added.length === 0) return candidate('The release-age gate kept blocking a version already excluded.', steps)
      steps = [...steps, ...added]
    }
    return candidate(`The release-age gate still blocked a version after ${MAX_ROUNDS} rounds.`, steps)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
