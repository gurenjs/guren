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

export interface GurenWorker {
  name: string
  entrypoint: string
  compatibilityFlags: string[]
  assets: { htmlHandling: WorkerManifest['htmlHandling'] }
  env: Record<string, GurenBinding>
  exports: Record<string, { type: 'durable-object'; storage: 'sqlite' }>
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
      `@guren/plugin-cloudflare/config: ${path} not found. Run \`bunx guren cloudflare:build\` before \`cf build\` or \`cf deploy\`; it writes this manifest.`,
    )
  }

  const manifest = JSON.parse(text) as Partial<WorkerManifest>
  if (manifest.version !== WORKER_MANIFEST_VERSION) {
    throw new Error(
      `@guren/plugin-cloudflare/config: ${path} has manifest version ${String(manifest.version)}, and this plugin reads ${WORKER_MANIFEST_VERSION}. Run \`bunx guren cloudflare:build\` again with the installed plugin.`,
    )
  }
  return manifest as WorkerManifest
}
