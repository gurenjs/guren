/**
 * The build manifest `cloudflare:build` writes for the `cf` backend (RFC 0035 §3):
 * what `gurenWorker()` turns into `cloudflare.config.ts` bindings. It is written
 * by the Bun build and read under Node by `cf`, so this module imports nothing.
 */

/** The file name inside the output directory. */
export const WORKER_MANIFEST_FILE = 'guren-worker.json'

/** The `cf` backend's output directory, relative to the app root (RFC 0035 §3.3). */
export const CF_OUTPUT_DIR = '.guren/cloudflare'

export const WORKER_MANIFEST_VERSION = 1

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
  mcpOAuth: boolean
  /** Agent classes hosted as SQLite-backed Durable Objects, with the binding each gets. */
  agents: Array<{ exportName: string; binding: string }>
  /** Keyed by binding name. The build never writes an entry, only carries them over. */
  resolved: Record<string, ResolvedResource>
}
