/**
 * The build manifest `cloudflare:build` writes for the `cf` backend (RFC 0035 §3):
 * what `gurenWorker()` turns into `cloudflare.config.ts` bindings. It is written
 * by the Bun build and read under Node by `cf`, so this module imports nothing.
 * On the Wrangler backend it holds only `version` and `resolved`.
 */

/** The file name inside the output directory. */
export const WORKER_MANIFEST_FILE = 'guren-worker.json'

/** The `cf` backend's output directory, relative to the app root (RFC 0035 §3.3). */
export const CF_OUTPUT_DIR = '.guren/cloudflare'

/** The Wrangler backend's, which the committed wrangler.jsonc points into. */
export const WRANGLER_OUTPUT_DIR = '.cloudflare'

/** The output directory of each backend, which the build writes and the deploy reads. */
export function outputDirFor(backend: 'cf' | 'wrangler'): string {
  return backend === 'cf' ? CF_OUTPUT_DIR : WRANGLER_OUTPUT_DIR
}

/** Inside the output directory: the flattened copy of `db/migrations`. */
export const D1_MIGRATIONS_DIR = 'd1-migrations'

/** The Wrangler backend's deploy config, rendered into its output directory with the resolved ids. */
export const WRANGLER_DEPLOY_CONFIG_FILE = 'wrangler.deploy.json'

export const WORKER_MANIFEST_VERSION = 2

/** One binding's resource identity, settled by a deploy and carried over by every build. */
export interface ResolvedResource {
  id?: string
  name?: string
}

export interface WorkerManifest {
  version: typeof WORKER_MANIFEST_VERSION
  /** Paths are relative to the app root, POSIX, each starting with `./`. */
  entrypoint: string
  assetsDirectory: string
  compatibilityFlags: string[]
  htmlHandling: 'none'
  alias: Record<string, string>
  define: Record<string, string>
  /** Plain-text bindings; `define` cannot reach a runtime `process.env[key]` read. */
  vars: Record<string, string>
  d1: { binding: string; databaseName: string }
  /** KV namespace bindings the build owns (`OAUTH_KV` under `--mcp-oauth`). */
  kvNamespaces: string[]
  /** Cron schedules for a `scheduled` trigger; empty when the worker schedules nothing. */
  crons: string[]
  /** `config/cloudflare.ts` names by binding, which the plan resolves and creates under. */
  resourceNames: Record<string, string>
  /** Why the schedule kernel could not be read; the plan blocks unless the config sets its own triggers. */
  scheduleUnreadable?: string
  /** Agent classes hosted as SQLite-backed Durable Objects, with the binding each gets. */
  agents: Array<{ exportName: string; binding: string }>
  /** R2 bucket bindings the introspected app's disks name (RFC 0035 §2); absent from a manifest older than that. */
  r2Buckets?: string[]
  /** Keyed by binding name. The build never writes an entry, only carries them over. */
  resolved: Record<string, ResolvedResource>
}

/** The name `cf` and Wrangler provision a binding under: `<worker>-<binding>`, `_` as `-` (RFC 0035 §4). */
export function autoProvisionedName(worker: string, binding: string): string {
  return `${worker}-${binding.toLowerCase().replaceAll('_', '-')}`
}

/** A binding's resource name: one the config states, then `config/cloudflare.ts`'s, then the default. */
export function resourceName(worker: string, binding: string, resourceNames: Readonly<Record<string, string>> | undefined, stated?: string): string {
  return stated ?? resourceNames?.[binding] ?? autoProvisionedName(worker, binding)
}
