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
  /** Keyed by binding name. The build never writes an entry, only carries them over. */
  resolved: Record<string, ResolvedResource>
}
