import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  const written: string[] = []
  const skipped: string[] = []

  for (const entry of entries) {
    if (!entry.from || !entry.to) {
      throw new Error(`Invalid publish entry in "${packageName}": both "from" and "to" are required.`)
    }
    if (isAbsolute(entry.from) || isAbsolute(entry.to)) {
      throw new Error(`Invalid publish entry in "${packageName}": absolute paths are not allowed.`)
    }

    const fromPath = resolve(packageDir, entry.from)
    if (relative(packageDir, fromPath).startsWith('..')) {
      throw new Error(
        `Invalid publish entry in "${packageName}": source "${entry.from}" escapes the package directory.`,
      )
    }

    const toPath = resolve(cwd, entry.to)
    const toRelative = relative(cwd, toPath)
    if (toRelative.startsWith('..')) {
      throw new Error(
        `Invalid publish entry in "${packageName}": target "${entry.to}" escapes the project directory.`,
      )
    }
    if (!PUBLISH_TARGET_ROOTS.some((root) => toRelative.startsWith(root))) {
      throw new Error(
        `Invalid publish entry in "${packageName}": target "${entry.to}" must be inside ${PUBLISH_TARGET_ROOTS.join(', ')}.`,
      )
    }

    if (!options.force && await fileExists(cwd, toRelative)) {
      skipped.push(entry.to)
      continue
    }

    await mkdir(dirname(toPath), { recursive: true })
    await copyFile(fromPath, toPath)
    written.push(entry.to)
  }

  return { written, skipped }
}
