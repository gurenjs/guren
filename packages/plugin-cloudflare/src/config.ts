/**
 * `@guren/plugin-cloudflare/config`: Guren's part of `cloudflare.config.ts` and
 * `wrangler.config.ts` for the `cf` CLI (RFC 0035 §3). `cf` evaluates those files
 * under Node, in another process from the Bun build that knows the app, so this
 * module computes nothing about the app: it reads the manifest `cloudflare:build`
 * wrote, and imports only Node builtins and the manifest's types.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  CF_OUTPUT_DIR,
  WORKER_MANIFEST_FILE,
  WORKER_MANIFEST_VERSION,
  type WorkerManifest,
} from './worker-manifest'

/**
 * Guren's deploy settings, read by `cloudflare:build` and `cloudflare:deploy` and never by
 * the running app (RFC 0035 §3). Default-exported from `config/cloudflare.ts`.
 */
export interface CloudflareDeployConfig {
  /** Front the App MCP endpoint with the OAuth provider, which binds `OAUTH_KV`. Replaces `--mcp-oauth`. */
  mcpOAuth?: boolean
  /** Where the App MCP endpoint is mounted, as `mcpPlugin({ path })` has it. Defaults to `/mcp`. */
  mcpPath?: string
  /** Resource names by binding (`DB`, `OAUTH_KV`), for one the default name does not fit or collides with. */
  resourceNames?: Record<string, string>
}

export function defineCloudflareConfig(config: CloudflareDeployConfig): CloudflareDeployConfig {
  return config
}

export interface GurenWorkerOptions {
  /** The Worker's name, the same one `cf deploy` deploys under. */
  name: string
  /** The `cloudflare:build` output directory, relative to the app root. Defaults to `.guren/cloudflare`. */
  outputDir?: string
}

/** The bindings and exports below are the plain objects `bindings.*()` and `exports.*()` from `cf/config` return. */
export type GurenBinding =
  | { type: 'd1'; name?: string; id?: string }
  | { type: 'kv'; id?: string }
  | { type: 'durable-object'; worker: string; exportName: string }
  | { type: 'text'; value: string }

export interface GurenWorker {
  name: string
  entrypoint: string
  compatibilityFlags: string[]
  assets: { htmlHandling: WorkerManifest['htmlHandling'] }
  env: Record<string, GurenBinding>
  exports: Record<string, { type: 'durable-object'; storage: 'sqlite' }>
  /** Absent when nothing is scheduled; a `triggers` key after the spread replaces it. */
  triggers?: Array<{ type: 'scheduled'; schedule: string }>
}

export interface GurenWranglerBundle {
  keepNames: true
  alias: Record<string, string>
  define: Record<string, string>
  assetsDirectory: string
}

/**
 * The Worker as `cloudflare:build` assembled it, to spread into `defineConfig({ worker })`.
 * `compatibilityDate` is left to the config file: a date that moved with each
 * build would change the runtime's behaviour on every deploy.
 */
export async function gurenWorker(options: GurenWorkerOptions): Promise<GurenWorker> {
  const manifest = await readWorkerManifest(options.outputDir)
  const resolved = manifest.resolved
  const env: Record<string, GurenBinding> = {}

  const d1 = resolved[manifest.d1.binding]
  env[manifest.d1.binding] = {
    type: 'd1',
    name: d1?.name ?? manifest.d1.databaseName,
    ...(d1?.id ? { id: d1.id } : {}),
  }
  for (const binding of manifest.kvNamespaces) {
    const id = resolved[binding]?.id
    env[binding] = { type: 'kv', ...(id ? { id } : {}) }
  }

  for (const [key, value] of Object.entries(manifest.vars)) {
    env[key] = { type: 'text', value }
  }

  const exports: GurenWorker['exports'] = {}
  for (const agent of manifest.agents) {
    env[agent.binding] = { type: 'durable-object', worker: options.name, exportName: agent.exportName }
    exports[agent.exportName] = { type: 'durable-object', storage: 'sqlite' }
  }

  return {
    name: options.name,
    entrypoint: manifest.entrypoint,
    compatibilityFlags: manifest.compatibilityFlags,
    assets: { htmlHandling: manifest.htmlHandling },
    env,
    exports,
    ...(manifest.crons.length > 0 ? { triggers: manifest.crons.map((schedule) => ({ type: 'scheduled' as const, schedule })) } : {}),
  }
}

/**
 * The bundler options for `defineWranglerConfig()`. `keepNames` is pinned on:
 * queued jobs, events, notifications and durable agents are stored by class name.
 */
export async function gurenWranglerBundle(
  options: Pick<GurenWorkerOptions, 'outputDir'> = {},
): Promise<GurenWranglerBundle> {
  const manifest = await readWorkerManifest(options.outputDir)
  return {
    keepNames: true,
    alias: manifest.alias,
    define: manifest.define,
    assetsDirectory: manifest.assetsDirectory,
  }
}

/** `cf` runs from the app root (it refuses a directory without the project's manifest), so paths resolve from the cwd. */
async function readWorkerManifest(outputDir = CF_OUTPUT_DIR): Promise<WorkerManifest> {
  const path = resolve(process.cwd(), outputDir, WORKER_MANIFEST_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `@guren/plugin-cloudflare/config: ${path} not found. Run \`bunx guren cloudflare:build\` before \`cf build\` or \`cf deploy\`; it writes this manifest. A build given another outputDir needs the same outputDir here.`,
    )
  }

  let manifest: Partial<WorkerManifest> | null
  try {
    manifest = JSON.parse(text) as Partial<WorkerManifest> | null
  } catch {
    manifest = null
  }
  if (manifest?.version !== WORKER_MANIFEST_VERSION) {
    throw new Error(
      `@guren/plugin-cloudflare/config: ${path} is not a version ${WORKER_MANIFEST_VERSION} manifest (it reads ${manifest === null ? 'as no JSON object' : `version ${String(manifest.version)}`}). Run \`bunx guren cloudflare:build\` again with the installed plugin.`,
    )
  }
  return manifest as WorkerManifest
}
