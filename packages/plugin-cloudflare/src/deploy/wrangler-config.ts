/**
 * The Wrangler backend's view of `wrangler.jsonc` (RFC 0035 §7): read as the
 * evaluated Worker the plan resolves, and rendered into `<out>/wrangler.deploy.json`
 * with the resolved ids filled in. wrangler.jsonc itself is never written. Only the
 * top level is deployed; named environments come in a later phase.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { isRecord } from '../backend'
import { asArray, configScopes, isPlaceholderId } from '../build'
import type { ResolvedResource } from '../worker-manifest'
import type { Read } from './cf-cli'
import type { EvaluatedBinding, EvaluatedWorker } from './plan'

/** The plan's view of the top level: a placeholder id reads as no id, as `wrangler deploy` would not bind it. */
export function evaluateWranglerConfig(config: Record<string, unknown>): EvaluatedWorker {
  if (typeof config.name !== 'string' || config.name === '') {
    throw new Error('Cloudflare deploy: wrangler.jsonc has no "name", so there is no Worker to deploy.')
  }
  const env: Record<string, EvaluatedBinding> = {}
  for (const entry of asArray(config.d1_databases)) {
    if (!isRecord(entry) || typeof entry.binding !== 'string') continue
    env[entry.binding] = {
      type: 'd1',
      ...(realId(entry.database_id) ? { id: entry.database_id as string } : {}),
      ...(typeof entry.database_name === 'string' ? { name: entry.database_name } : {}),
    }
  }
  for (const entry of asArray(config.kv_namespaces)) {
    if (!isRecord(entry) || typeof entry.binding !== 'string') continue
    env[entry.binding] = { type: 'kv', ...(realId(entry.id) ? { id: entry.id as string } : {}) }
  }
  for (const [name, value] of Object.entries(isRecord(config.vars) ? config.vars : {})) {
    env[name] = { type: typeof value === 'string' ? 'text' : 'json' }
  }
  const crons = isRecord(config.triggers) ? asArray(config.triggers.crons) : []
  return { name: config.name, env, scheduled: crons.length > 0 }
}

function realId(id: unknown): boolean {
  return typeof id === 'string' && id !== '' && !isPlaceholderId(id)
}

/**
 * The D1 binding `db/migrations` belongs to: the one whose `migrations_dir` is the
 * build's flattened copy, else the only D1 binding, else none can be told apart.
 */
export function wranglerMigrationsBinding(config: Record<string, unknown>, root: string, flatDir: string): Read<string | undefined> {
  const databases = asArray(config.d1_databases).filter(
    (entry): entry is Record<string, unknown> & { binding: string } => isRecord(entry) && typeof entry.binding === 'string',
  )
  const pointing = databases.filter((entry) => typeof entry.migrations_dir === 'string' && resolve(root, entry.migrations_dir) === flatDir)
  if (pointing.length === 1 && pointing[0]) return { ok: true, value: pointing[0].binding }
  if (pointing.length > 1) {
    return { ok: false, reason: `wrangler.jsonc gives ${pointing.map((entry) => entry.binding).join(' and ')} the same migrations_dir, so which database db/migrations belongs to is unknown` }
  }
  if (databases.length === 0) return { ok: true, value: undefined }
  const only = databases.length === 1 ? databases[0] : undefined
  if (only && only.migrations_dir === undefined) return { ok: true, value: only.binding }
  return {
    ok: false,
    reason: `no D1 binding in wrangler.jsonc sets migrations_dir to ${flatDir}, where the build flattens db/migrations, so which database they belong to is unknown`,
  }
}

/** The table `wrangler d1 migrations apply` records into for a binding (`migrations_table`). */
export function wranglerMigrationsTable(config: Record<string, unknown>, binding: string): string | undefined {
  const entry = asArray(config.d1_databases).find((candidate) => isRecord(candidate) && candidate.binding === binding)
  return isRecord(entry) && typeof entry.migrations_table === 'string' && entry.migrations_table !== '' ? entry.migrations_table : undefined
}

/** Keys holding a path wrangler resolves against the config file's directory. */
const PATH_KEYS = ['main', 'tsconfig', 'base_dir'] as const
const PATH_MAPS = ['wasm_modules', 'text_blobs', 'data_blobs'] as const

/**
 * wrangler.jsonc with every path absolute (the file sits in the output directory, not
 * the app root), the resolved ids filled in on the top level, and the migrations
 * binding pointed at the flattened copy.
 */
export function renderWranglerDeployConfig(input: {
  root: string
  config: Record<string, unknown>
  resolved: Readonly<Record<string, ResolvedResource>>
  migrationsBinding: string | undefined
  flatDir: string
}): Record<string, unknown> {
  const { root } = input
  const config = structuredClone(input.config)
  const absolute = (value: unknown) => (typeof value === 'string' && value !== '' && !isAbsolute(value) ? resolve(root, value) : value)

  for (const { config: scope } of configScopes(config)) {
    for (const key of PATH_KEYS) {
      if (key in scope) scope[key] = absolute(scope[key])
    }
    for (const key of PATH_MAPS) {
      const map = scope[key]
      if (isRecord(map)) for (const name of Object.keys(map)) map[name] = absolute(map[name])
    }
    if (isRecord(scope.assets)) scope.assets.directory = absolute(scope.assets.directory)
    if (isRecord(scope.site)) scope.site.bucket = absolute(scope.site.bucket)
    if (isRecord(scope.build)) {
      // A build command runs in `build.cwd`, which defaults to the config's directory.
      scope.build.cwd = absolute(scope.build.cwd ?? '.')
      const watch = scope.build.watch_dir
      scope.build.watch_dir = Array.isArray(watch) ? watch.map(absolute) : absolute(watch)
    }
    if (isRecord(scope.alias)) {
      for (const [name, target] of Object.entries(scope.alias)) {
        if (typeof target === 'string' && target.startsWith('.')) scope.alias[name] = resolve(root, target)
      }
    }
    for (const entry of asArray(scope.d1_databases)) {
      if (isRecord(entry) && 'migrations_dir' in entry) entry.migrations_dir = absolute(entry.migrations_dir)
    }
    // An image is a Dockerfile path when one exists there, otherwise a registry reference.
    for (const container of asArray(scope.containers)) {
      if (!isRecord(container)) continue
      if (typeof container.image === 'string' && existsSync(resolve(root, container.image))) container.image = absolute(container.image)
      if ('image_build_context' in container) container.image_build_context = absolute(container.image_build_context)
    }
  }

  for (const entry of asArray(config.d1_databases)) {
    if (!isRecord(entry) || typeof entry.binding !== 'string') continue
    const id = input.resolved[entry.binding]?.id
    if (id) entry.database_id = id
    if (entry.binding === input.migrationsBinding) entry.migrations_dir = input.flatDir
  }
  for (const entry of asArray(config.kv_namespaces)) {
    if (!isRecord(entry) || typeof entry.binding !== 'string') continue
    const id = input.resolved[entry.binding]?.id
    if (id) entry.id = id
  }
  return config
}
