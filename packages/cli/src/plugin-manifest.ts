import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileExists, readIfExists } from './discovery'

/**
 * Declarative `gurenPlugin` manifest read from a plugin package's
 * package.json. The manifest is pure data — `guren plugin` never imports or
 * executes plugin code.
 */
export interface GurenPluginManifest {
  /** Semver range of Guren versions this plugin supports. */
  compatibility?: string
  /** Named provider export to register in createApp({ providers }). */
  provider?: string
  /** Env keys appended to .env.example (and .env when present). */
  env?: GurenPluginEnvEntry[]
  /** Files copied from the package into the application. */
  publishes?: GurenPluginPublishEntry[]
  /** CLI commands contributed by the plugin (RFC 0001, Part C). */
  commands?: GurenPluginCommands
}

export interface GurenPluginEnvEntry {
  key: string
  value?: string
  comment?: string
}

export interface GurenPluginPublishEntry {
  from: string
  to: string
}

export interface GurenPluginCommands {
  entry: string
  names: string[]
}

/** Application directories a plugin is allowed to publish files into. */
export const PUBLISH_TARGET_ROOTS = ['config/', 'db/migrations/', 'resources/'] as const

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u

// Bun is only available at runtime. The declaration keeps TypeScript happy
// while allowing the compatibility check to no-op on other runtimes.
declare const Bun:
  | { semver: { satisfies(version: string, range: string): boolean } }
  | undefined

/**
 * Read the `gurenPlugin` manifest from an installed package.
 * Returns null when the package or the field is absent.
 */
export async function readPluginManifest(
  packageName: string,
  cwd: string = process.cwd(),
): Promise<GurenPluginManifest | null> {
  const raw = await readIfExists(cwd, join('node_modules', packageName, 'package.json'))
  if (raw === null) return null

  const parsed = JSON.parse(raw) as { gurenPlugin?: unknown }
  if (!parsed.gurenPlugin || typeof parsed.gurenPlugin !== 'object') {
    return null
  }

  return parsed.gurenPlugin as GurenPluginManifest
}

/**
 * Package names declared in the app's own package.json `dependencies` and
 * `devDependencies` — no node_modules lookup, so this resolves even for a
 * package that has never been installed. Returns `[]` when package.json is
 * missing or fails to parse.
 */
export async function readDeclaredDependencyNames(cwd: string = process.cwd()): Promise<string[]> {
  const packageJsonRaw = await readIfExists(cwd, 'package.json')
  if (packageJsonRaw === null) return []

  try {
    const parsed = JSON.parse(packageJsonRaw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]
  } catch {
    return []
  }
}

/**
 * Enumerate installed packages (dependencies and devDependencies of the
 * app's package.json) that declare a `gurenPlugin` manifest.
 */
export async function readInstalledPluginManifests(
  cwd: string = process.cwd(),
): Promise<Array<{ packageName: string; manifest: GurenPluginManifest }>> {
  const dependencies = await readDeclaredDependencyNames(cwd)

  const entries = await Promise.all(
    dependencies.map(async (packageName) => ({
      packageName,
      manifest: await readPluginManifest(packageName, cwd).catch(() => null),
    })),
  )

  return entries.flatMap((entry) =>
    entry.manifest ? [{ packageName: entry.packageName, manifest: entry.manifest }] : [],
  )
}

/**
 * Walk up from `candidate` to the nearest existing ancestor and return its
 * canonical (symlink-resolved) path, plus the non-existent tail rejoined
 * onto it. Lets callers realpath-validate a path that doesn't exist yet
 * (e.g. a publish target about to be created).
 */
async function realpathNearestExisting(candidate: string): Promise<string> {
  const tail: string[] = []
  let probe = candidate

  for (;;) {
    try {
      const real = await realpath(probe)
      return tail.length > 0 ? join(real, ...tail) : real
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) return candidate
      tail.unshift(basename(probe))
      probe = parent
    }
  }
}

/**
 * Resolve `relPath` against `baseDir`, returning null when the input is
 * absolute, escapes the base directory, or — once symlinks are resolved —
 * points outside it. `baseDir` and any existing ancestor of the resolved
 * path are canonicalized via `realpath` so a symlink inside the package
 * (or a symlinked `node_modules` entry) can't be used to read or write
 * outside the intended directory. The candidate path (not its realpath) is
 * returned so callers keep operating on the logical location.
 *
 * `extraRealRoots` are additional canonical directories the resolved path
 * may live in. Local installs (`bun add file:`, `link:`, `workspace:*`)
 * materialize a package as per-file symlinks into the source directory, so
 * every file's realpath escapes the node_modules entry while the entry
 * itself does not — package-side callers pass the package's content root
 * (see packageContentRoot) to accept that layout.
 */
export async function resolveInside(
  baseDir: string,
  relPath: string,
  extraRealRoots: string[] = [],
): Promise<string | null> {
  if (isAbsolute(relPath)) return null

  const candidate = resolve(baseDir, relPath)
  if (relative(baseDir, candidate).startsWith('..')) return null

  let realBase: string
  try {
    realBase = await realpath(baseDir)
  } catch {
    return null
  }

  const realCandidate = await realpathNearestExisting(candidate)
  const containedIn = (root: string): boolean => {
    const realRelative = relative(root, realCandidate)
    return !realRelative.startsWith('..') && !isAbsolute(realRelative)
  }
  if (![realBase, ...extraRealRoots].some(containedIn)) return null

  return candidate
}

/**
 * Canonical directory holding a package's actual content: the realpath
 * parent of its package.json. For a regular npm install this equals the
 * package directory itself; for per-file-symlink local installs it is the
 * source directory every file link points into. Returns null when
 * package.json cannot be resolved.
 */
export async function packageContentRoot(packageDir: string): Promise<string | null> {
  try {
    return dirname(await realpath(join(packageDir, 'package.json')))
  } catch {
    return null
  }
}

/**
 * Read the installed `@guren/core` version, or null when not installed.
 */
export async function readCoreVersion(cwd: string = process.cwd()): Promise<string | null> {
  const raw = await readIfExists(cwd, join('node_modules', '@guren/core', 'package.json'))
  if (raw === null) return null

  return (JSON.parse(raw) as { version?: string }).version ?? null
}

export interface CompatibilityResult {
  compatible: boolean
  coreVersion: string
  range: string
}

/**
 * Check a manifest's `compatibility` range against a core version.
 * Returns null when either side is unknown (no range declared, core version
 * unresolved, or a runtime without Bun.semver).
 */
export function checkPluginCompatibility(
  manifest: GurenPluginManifest,
  coreVersion: string | null,
): CompatibilityResult | null {
  const range = manifest.compatibility
  if (!range || !coreVersion || typeof Bun === 'undefined') return null

  return {
    compatible: Bun.semver.satisfies(coreVersion, range),
    coreVersion,
    range,
  }
}

/**
 * Append missing env keys to .env.example (created when absent) and .env
 * (only when it already exists). Returns the files that were modified.
 */
export async function applyEnvEntries(
  entries: GurenPluginEnvEntry[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const validEntries = entries.filter((entry) => ENV_KEY_PATTERN.test(entry.key ?? ''))
  if (validEntries.length === 0) return []

  const modified: string[] = []

  for (const file of ['.env.example', '.env']) {
    const existing = await readIfExists(cwd, file)

    // .env is only updated when it already exists
    if (existing === null && file === '.env') continue
    const content = existing ?? ''

    const missing = validEntries.filter(
      (entry) => !new RegExp(`^${entry.key}=`, 'm').test(content),
    )
    if (missing.length === 0) continue

    const blocks = missing.map((entry) => {
      const comment = entry.comment ? `# ${entry.comment}\n` : ''
      return `${comment}${entry.key}=${entry.value ?? ''}\n`
    })

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    await writeFile(resolve(cwd, file), `${content}${separator}${blocks.join('')}`, 'utf8')
    modified.push(file)
  }

  return modified
}

export interface PublishResult {
  written: string[]
  skipped: string[]
}

/**
 * Copy declared files from the installed package into the application.
 *
 * Targets are restricted to PUBLISH_TARGET_ROOTS, sources must stay inside
 * the package directory, and existing files are never overwritten unless
 * `force` is set.
 */
export async function applyPublishes(
  packageName: string,
  entries: GurenPluginPublishEntry[],
  options: { cwd?: string; force?: boolean } = {},
): Promise<PublishResult> {
  const cwd = options.cwd ?? process.cwd()
  const packageDir = resolve(cwd, 'node_modules', packageName)
  const contentRoot = await packageContentRoot(packageDir)
  const packageRoots = contentRoot ? [contentRoot] : []
  const invalid = (detail: string): Error => new Error(`Invalid publish entry in "${packageName}": ${detail}`)

  // Validate sequentially so the first invalid entry is always the one
  // reported, then copy files concurrently — each entry targets an
  // independent path with no cross-entry dependency.
  const resolved: Array<{ entry: GurenPluginPublishEntry; fromPath: string; toPath: string; toRelative: string }> = []

  for (const entry of entries) {
    if (!entry.from || !entry.to) {
      throw invalid('both "from" and "to" are required.')
    }
    if (isAbsolute(entry.from) || isAbsolute(entry.to)) {
      throw invalid('absolute paths are not allowed.')
    }

    const fromPath = await resolveInside(packageDir, entry.from, packageRoots)
    if (fromPath === null) {
      throw invalid(`source "${entry.from}" escapes the package directory.`)
    }

    const toPath = await resolveInside(cwd, entry.to)
    if (toPath === null) {
      throw invalid(`target "${entry.to}" escapes the project directory.`)
    }
    const toRelative = relative(cwd, toPath)
    if (!PUBLISH_TARGET_ROOTS.some((root) => toRelative.startsWith(root))) {
      throw invalid(`target "${entry.to}" must be inside ${PUBLISH_TARGET_ROOTS.join(', ')}.`)
    }

    resolved.push({ entry, fromPath, toPath, toRelative })
  }

  const written: string[] = []
  const skipped: string[] = []

  await Promise.all(resolved.map(async ({ entry, fromPath, toPath, toRelative }) => {
    if (!options.force && await fileExists(cwd, toRelative)) {
      skipped.push(entry.to)
      return
    }

    await mkdir(dirname(toPath), { recursive: true })
    await copyFile(fromPath, toPath)
    written.push(entry.to)
  }))

  return { written, skipped }
}
