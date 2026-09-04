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

/**
 * Reserved by the framework: `GUREN_TESTING`, `GUREN_MCP` and
 * `GUREN_ALLOW_UNVERIFIED_PEER` are whole security gates on their own, and a
 * line appended to `.env.example` is committed and reaches every clone. So a
 * plugin setting one is refused loudly rather than filtered out in silence.
 */
const RESERVED_ENV_PREFIX = 'GUREN_'

// Declared rather than imported so the compatibility check can no-op on a
// runtime without Bun.
declare const Bun:
  | { semver: { satisfies(version: string, range: string): boolean } }
  | undefined

/** Null when the package or the `gurenPlugin` field is absent. */
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
 * From the app's own package.json, with no node_modules lookup, so a package
 * that has never been installed still resolves.
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

/** Installed dependencies that declare a `gurenPlugin` manifest. */
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
 * The nearest existing ancestor's canonical path with the missing tail
 * rejoined, so a path that does not exist yet can still be realpath-validated.
 * A copy of `realpathOfNearestExisting` in `@guren/core`'s deploy-build module
 * (which cannot import cli); keep the ENOENT-only walk-up in step.
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
 * Null when `relPath` is absolute or escapes `baseDir`, symlinks resolved, so
 * a link inside the package cannot read or write outside it. The candidate
 * path is returned rather than its realpath, keeping callers on the logical
 * location. `extraRealRoots` admits local installs (`bun add file:`, `link:`,
 * `workspace:*`), whose per-file symlinks all point outside node_modules —
 * package-side callers pass `packageContentRoot()`.
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
 * The realpath parent of a package's package.json: the package directory for a
 * regular install, the source directory for a per-file-symlink local install.
 */
export async function packageContentRoot(packageDir: string): Promise<string | null> {
  try {
    return dirname(await realpath(join(packageDir, 'package.json')))
  } catch {
    return null
  }
}

/** The installed `@guren/core` version, or null when not installed. */
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
 * Null when either side is unknown: no range declared, core version
 * unresolved, or a runtime without `Bun.semver`.
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
 * Rejects env entries a plugin may not write. Call it *before* an install
 * starts mutating the project: `applyEnvEntries` calls it too, but by then the
 * provider is wired into `src/app.ts` and publishes may be on disk, so a throw
 * there leaves the rest of the install applied.
 */
export function assertEnvEntriesAllowed(entries: GurenPluginEnvEntry[]): void {
  for (const entry of entries) {
    if (entry.key?.startsWith(RESERVED_ENV_PREFIX)) {
      throw new Error(
        `Invalid env entry "${entry.key}": ${RESERVED_ENV_PREFIX}* is reserved by the framework and cannot be set by a plugin.`,
      )
    }

    // A newline starts a line the key never names, so `{ key: 'ACME_KEY',
    // value: '\nGUREN_TESTING=1' }` would write a second, reserved entry.
    for (const field of ['value', 'comment'] as const) {
      const text = entry[field]
      if (text !== undefined && /[\r\n]/.test(text)) {
        throw new Error(`Invalid env entry "${entry.key}": ${field} cannot contain a line break.`)
      }
    }
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
  assertEnvEntriesAllowed(validEntries)
  if (validEntries.length === 0) return []

  const modified: string[] = []

  for (const file of ['.env.example', '.env']) {
    const existing = await readIfExists(cwd, file)

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
 * Copies declared files from the installed package into the application.
 * Targets are restricted to PUBLISH_TARGET_ROOTS and sources must stay inside
 * the package directory.
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

  // Validated sequentially so the first invalid entry is always the one
  // reported; the copies afterwards are independent and run concurrently.
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
