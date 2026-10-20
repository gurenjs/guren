/**
 * `guren cloudflare:deploy` (RFC 0035 §1), stages 1 to 3 so far: preflight,
 * assemble, plan. Creating resources, migrating and deploying come later, so the
 * command runs only with `--plan`, which writes nothing to the account.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { detectCloudflareBackend } from '../backend'
import { buildCloudflareOutput } from '../build'
import { CF_OUTPUT_DIR, WORKER_MANIFEST_FILE, type WorkerManifest } from '../worker-manifest'
import { appCfRunner, cfBuild, checkAuth, listD1Databases, listKvNamespaces, type CfRunner } from './cf-cli'
import { buildPlan, hasBlocker, type DeployPlan, type EvaluatedBinding, type EvaluatedWorker } from './plan'

/** cf refuses to load cloudflare.config.ts on older Node (RFC 0035 Appendix C row 10). */
const NODE_FLOOR = [22, 18, 0] as const
/** The Wrangler cf delegates the bundle to (Appendix C row 17). */
const WRANGLER_FLOOR = [4, 136, 0] as const

/** Where `cf build` writes the evaluated Worker configuration. */
const EVALUATED_CONFIG = '.cloudflare/output/v0/workers/default/worker.config.json'

export interface CloudflareDeployOptions {
  root: string
  /** Stop after the plan. Required until stages 4 to 8 exist. */
  plan: boolean
  ci?: boolean
  provision?: boolean
  mcpOAuth?: boolean
  skipAppBuild?: boolean
  /** Seams for tests: the `cf` runner, the version of `node` on PATH, and whether a person is at the terminal. */
  cf?: CfRunner
  nodeVersion?: () => string | undefined
  interactive?: boolean
}

export async function planCloudflareDeploy(options: CloudflareDeployOptions): Promise<DeployPlan> {
  const root = resolve(options.root)
  if (!options.plan) {
    throw new Error(
      'Cloudflare deploy: only `--plan` is available in this version. It reports what a deploy would create and bind, and changes nothing; creating resources, migrating and deploying land in a later release.',
    )
  }

  const cf = options.cf ?? appCfRunner(root)
  preflight(root, cf, options.nodeVersion ?? nodeOnPathVersion)

  await buildCloudflareOutput({
    rootDir: root,
    skipAppBuild: options.skipAppBuild,
    mcpOAuth: options.mcpOAuth,
  })

  const built = cfBuild(cf)
  if (!built.ok) {
    throw new Error(`Cloudflare deploy: \`cf build\` failed, so cloudflare.config.ts could not be evaluated:\n${built.reason}`)
  }

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  return buildPlan({
    worker: readEvaluatedWorker(root),
    manifest: readManifest(root),
    d1: listD1Databases(cf),
    kv: listKvNamespaces(cf),
    mayCreate: Boolean(options.provision) || (!options.ci && interactive),
  })
}

/** Checks only the cf backend's tools, before anything is built (RFC 0035 §7). */
function preflight(root: string, cf: CfRunner, nodeVersion: () => string | undefined): void {
  if (detectCloudflareBackend(root) !== 'cf') {
    throw new Error(
      'Cloudflare deploy: needs the cf backend, a cloudflare.config.ts and `cf` declared (see the Cloudflare guide). An app deploying through wrangler.jsonc keeps using `cloudflare:build` and `wrangler deploy`.',
    )
  }

  const problems: string[] = []
  if (!existsSync(join(root, 'node_modules', 'cf', 'bin', 'cf'))) {
    problems.push('cf is declared but not installed. Run `bun install`.')
  }
  const node = nodeVersion()
  if (!node || compareVersions(node, NODE_FLOOR) < 0) {
    problems.push(`cf loads cloudflare.config.ts with the node on PATH, which needs Node ${NODE_FLOOR.join('.')} or later; found ${node ?? 'no node'}.`)
  }
  const wrangler = installedVersion(root, 'wrangler')
  if (!wrangler || compareVersions(wrangler, WRANGLER_FLOOR) < 0) {
    problems.push(`cf bundles through the app's Wrangler, which needs ${WRANGLER_FLOOR.join('.')} or later; found ${wrangler ?? 'none'}. Run \`bun add -d wrangler@latest\`.`)
  }
  if (problems.length === 0) {
    const auth = checkAuth(cf)
    if (!auth.ok) {
      problems.push(`cf is not logged in (${auth.reason}). Run \`bunx cf auth login\`, or set CLOUDFLARE_API_TOKEN in CI.`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`Cloudflare deploy: preflight failed, before anything was built:\n  ${problems.join('\n  ')}`)
  }
}

function readEvaluatedWorker(root: string): EvaluatedWorker {
  const path = join(root, EVALUATED_CONFIG)
  const config = readJson(path)
  if (!isRecord(config) || typeof config.name !== 'string' || (config.env !== undefined && !isRecord(config.env))) {
    throw new Error(`Cloudflare deploy: ${path} is missing or not the shape \`cf build\` writes, so the bindings could not be read.`)
  }
  const env: Record<string, EvaluatedBinding> = {}
  for (const [binding, entry] of Object.entries(config.env ?? {})) {
    if (isRecord(entry) && typeof entry.type === 'string') {
      env[binding] = {
        type: entry.type,
        ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      }
    }
  }
  return { name: config.name, env }
}

function readManifest(root: string): Pick<WorkerManifest, 'resolved'> {
  const manifest = readJson(join(root, CF_OUTPUT_DIR, WORKER_MANIFEST_FILE))
  return { resolved: isRecord(manifest) && isRecord(manifest.resolved) ? (manifest.resolved as WorkerManifest['resolved']) : {} }
}

function nodeOnPathVersion(): string | undefined {
  try {
    const result = Bun.spawnSync({ cmd: ['node', '--version'], stdout: 'pipe', stderr: 'pipe' })
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

function installedVersion(root: string, name: string): string | undefined {
  const manifest = readJson(join(root, 'node_modules', name, 'package.json'))
  return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined
}

/** Compares the numeric `major.minor.patch` prefix; a pre-release counts as its release. */
export function compareVersions(version: string, floor: readonly [number, number, number]): number {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!parts) return -1
  for (let index = 0; index < 3; index++) {
    const difference = Number(parts[index + 1]) - floor[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { hasBlocker }
