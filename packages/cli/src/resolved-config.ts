/**
 * The app's configuration, computed by importing it (RFC 0027 §6). A definition
 * is data whose `resolve` is a pure function of the validated environment, so a
 * command can read a config without booting the app. Once per app root per
 * process: Bun keys a module on its resolved path, so a second load would hand
 * back the first copy regardless.
 */
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { recordEnvReads } from '@guren/core'
import { loadEnvSchema, type DeclaredEnvVars } from './app-env'

export const CONFIG_DIRECTORY = 'config'

export interface ResolvedConfigEntry {
  /** The definition's own key, which need not be the file's name; the file name when there is none. */
  readonly key: string
  /** Relative to the app root, as a check result names it. */
  readonly file: string
  readonly config?: unknown
  /** The environment keys `resolve()` read, for a verdict that re-resolves an enum. */
  readonly read: readonly string[]
  /** Why there is no config: the import failed, the export is not a definition, or `resolve()` threw. */
  readonly problem?: string
}

export interface ResolvedConfig {
  readonly entries: readonly ResolvedConfigEntry[]
  /** The values each `Env.enum()` key admits, for the verdicts that judge every store a schema allows. */
  readonly choices: ReadonlyMap<string, readonly string[]>
  /** Why the environment could not be validated; every definition then resolves against an empty one. */
  readonly envProblem?: string
}

const loaded = new Map<string, Promise<ResolvedConfig>>()

export function loadResolvedConfig(cwd: string): Promise<ResolvedConfig> {
  const root = resolve(cwd)
  let pending = loaded.get(root)
  if (!pending) {
    pending = readResolvedConfig(root)
    loaded.set(root, pending)
  }
  return pending
}

async function readResolvedConfig(cwd: string): Promise<ResolvedConfig> {
  const files = await configFiles(cwd)
  if (files.length === 0) return { entries: [], choices: new Map() }

  const schema = await loadEnvSchema(cwd)
  const envProblem = schema.status === 'unreadable' ? schema.message : undefined
  const values = schema.status === 'loaded' ? parseValues(schema.schema) : {}
  const choices = schema.status === 'loaded' ? enumChoices(schema.vars) : new Map<string, readonly string[]>()

  const entries = await Promise.all(files.map((file) => resolveEntry(cwd, file, values)))
  return { entries, choices, ...(envProblem ? { envProblem } : {}) }
}

/** Report mode: a command reads a config on a machine that holds none of the app's secrets. */
function parseValues(schema: { parse: (source?: undefined, options?: { mode?: 'report' }) => { values: unknown } }): object {
  try {
    return schema.parse(undefined, { mode: 'report' }).values as object
  } catch {
    return {}
  }
}

function enumChoices(vars: DeclaredEnvVars): Map<string, readonly string[]> {
  return new Map(
    Object.entries(vars).flatMap(([key, spec]) => (spec.choices ? [[key, spec.choices] as const] : [])),
  )
}

async function configFiles(cwd: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(join(cwd, CONFIG_DIRECTORY))
  } catch {
    return []
  }
  return names
    // `config/env.ts` is the schema every definition resolves against, not one of them.
    .filter((name) => /\.[jt]s$/u.test(name) && !/\.test\.[jt]s$/u.test(name) && !/^env\.[jt]s$/u.test(name))
    .sort()
    .map((name) => `${CONFIG_DIRECTORY}/${name}`)
}

async function resolveEntry(cwd: string, file: string, values: object): Promise<ResolvedConfigEntry> {
  const key = basename(file).replace(/\.[jt]s$/u, '')

  let exported: unknown
  try {
    exported = ((await import(pathToFileURL(join(cwd, file)).href)) as { default?: unknown }).default
  } catch (error) {
    return { key, file, read: [], problem: `failed to import: ${messageOf(error)}` }
  }

  const definition = exported as { key?: unknown; resolve?: unknown; bind?: unknown } | null | undefined
  if (typeof definition?.key !== 'string' || typeof definition.resolve !== 'function' || typeof definition.bind !== 'function') {
    return { key, file, read: [], problem: 'does not default-export a config definition' }
  }

  const { env, read } = recordEnvReads(values as never)
  try {
    const config: unknown = (definition.resolve as (env: unknown) => unknown)(env)
    return { key: definition.key, file, config, read: [...read] }
  } catch (error) {
    return { key: definition.key, file, read: [...read], problem: `resolve() threw: ${messageOf(error)}` }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
