/**
 * `guren cloudflare:deploy` (RFC 0035 §1), stages 1 to 3 so far: preflight,
 * assemble, plan. Creating resources, migrating and deploying come later, so the
 * command runs only with `--plan`, which writes nothing to the account.
 */
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { detectCloudflareBackend } from '../backend'
import { buildCloudflareOutput, readResolvedResources } from '../build'
import { CF_OUTPUT_DIR } from '../worker-manifest'
import { appCfRunner, cfBuild, checkAuth, listD1Databases, listKvNamespaces, type CfRunner, type Read } from './cf-cli'
import { buildPlan, type DeployPlan, type EvaluatedBinding, type EvaluatedWorker } from './plan'

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
  mcpPath?: string
  skipAppBuild?: boolean
  /** Route the build's own output to stderr, so stdout carries only `--json`. */
  logToStderr?: boolean
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

  const cfBin = resolvePackageFile(root, 'cf/package.json')
  const cf = options.cf ?? appCfRunner(root, cfBin ? join(dirname(cfBin), 'bin', 'cf') : undefined)
  preflight(root, cf, cfBin, options.nodeVersion ?? nodeOnPathVersion)

  await withStdoutLogs(options.logToStderr === true, () =>
    buildCloudflareOutput({
      rootDir: root,
      skipAppBuild: options.skipAppBuild,
      mcpOAuth: options.mcpOAuth,
      ...(options.mcpPath ? { mcpPath: options.mcpPath } : {}),
      appBuildToStderr: options.logToStderr,
    }))

  // A file left by an earlier build must not pass for this evaluation.
  rmSync(join(root, EVALUATED_CONFIG), { force: true })
  const built = cfBuild(cf)
  if (!built.ok) {
    throw new Error(`Cloudflare deploy: \`cf build\` failed, so cloudflare.config.ts could not be evaluated:\n${built.reason}`)
  }

  // Whether a person can answer a prompt; piping the output elsewhere does not change it.
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY)
  const worker = readEvaluatedWorker(root)
  const uses = (type: string) => Object.values(worker.env).some((entry) => entry.type === type)
  const unlisted: Read<never[]> = { ok: true, value: [] }
  return buildPlan({
    worker,
    manifest: { resolved: readResolvedResources(join(root, CF_OUTPUT_DIR)) },
    d1: uses('d1') ? listD1Databases(cf) : unlisted,
    kv: uses('kv') ? listKvNamespaces(cf) : unlisted,
    mayCreate: Boolean(options.provision) || (!options.ci && interactive),
  })
}

async function withStdoutLogs<T>(toStderr: boolean, run: () => Promise<T>): Promise<T> {
  if (!toStderr) return run()
  const log = console.log
  console.log = console.error
  try {
    return await run()
  } finally {
    console.log = log
  }
}

/** Resolved the way Node resolves it from the app, so a hoisted workspace install is found. */
function resolvePackageFile(root: string, specifier: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, root)
  } catch {
    return undefined
  }
}

/** Checks only the cf backend's tools, before anything is built (RFC 0035 §7). */
function preflight(root: string, cf: CfRunner, cfPackage: string | undefined, nodeVersion: () => string | undefined): void {
  if (detectCloudflareBackend(root) !== 'cf') {
    throw new Error(
      'Cloudflare deploy: needs the cf backend, a cloudflare.config.ts and `cf` declared (see the Cloudflare guide). An app deploying through wrangler.jsonc keeps using `cloudflare:build` and `wrangler deploy`.',
    )
  }

  const problems: string[] = []
  if (!cfPackage) {
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

function nodeOnPathVersion(): string | undefined {
  try {
    const result = Bun.spawnSync({ cmd: ['node', '--version'], stdout: 'pipe', stderr: 'pipe' })
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

function installedVersion(root: string, name: string): string | undefined {
  const path = resolvePackageFile(root, `${name}/package.json`)
  const manifest = path ? readJson(path) : undefined
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

