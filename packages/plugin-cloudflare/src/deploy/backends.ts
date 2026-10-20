/**
 * The backend interface `cloudflare:deploy` runs its stages against (RFC 0035 §7).
 * Every operation on the account or a CLI goes through one of these, so the stages
 * in `deploy.ts` are written once. Which backend runs is `detectCloudflareBackend()`'s.
 */
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isRecord, type CloudflareBackend } from '../backend'
import { readWorkerManifest } from '../build'
import { CF_OUTPUT_DIR } from '../worker-manifest'
import {
  applyMigrations,
  appCfRunner,
  cfBuild,
  checkAuth,
  createD1Database,
  createKvNamespace,
  deployPrebuilt,
  getBookmark,
  listD1Databases,
  listKvNamespaces,
  listWorkerSecrets,
  readMigrationTracker,
  type AccountResource,
  type CfRunner,
  type Read,
} from './cf-cli'
import { migrationDirArgs, type MigrationLayout } from './migrations'
import type { EvaluatedBinding, EvaluatedWorker, PlannedBinding, ResourceType } from './plan'

export interface DeployBackend {
  readonly kind: CloudflareBackend
  /** The output directory, relative to the app root, holding the build and its manifest. */
  readonly outputDir: string
  /** Problems that stop the run before anything is built; the account is asked only when the tools are there. */
  preflight(): string[]
  /** The Worker the deploy would upload, read after the assemble stage. */
  evaluate(): EvaluatedWorker
  /** The D1 binding `db/migrations` is applied to, or why none could be chosen. */
  migrationsBinding(worker: EvaluatedWorker): Read<string | undefined>
  /** Called once the bindings are planned and before any read that needs a database by its id. */
  prepareReads(bindings: readonly PlannedBinding[]): void
  list(type: ResourceType): Read<AccountResource[]>
  /** The new resource's id. */
  create(type: ResourceType, name: string): Read<string>
  /** Makes the deploy build bind `resolved`, after stage 4 changed it; the message names the problem. */
  rebuild(resolved: Readonly<Record<string, { id?: string }>>): Read<true>
  /** Whether the nested layout (`<folder>/migration.sql`) can be applied at all. */
  readonly appliesNested: boolean
  applyArgs(layout: MigrationLayout): string[]
  readTracker(database: PlannedBinding & { id: string }): Read<string[] | null>
  bookmark(database: PlannedBinding & { id: string }): Read<string>
  applyMigrations(database: PlannedBinding & { id: string }, applyArgs: string[]): Read<string>
  listSecrets(worker: string): Read<string[]>
  deploy(secretsFile: string | undefined): Read<string>
  restoreCommand(database: { id: string; name: string }, bookmark: string): string
  deleteCommand(resource: { type: ResourceType; id: string; name: string }): string
}

/** cf refuses to load cloudflare.config.ts on older Node (RFC 0035 Appendix C row 10). */
const NODE_FLOOR = '22.18.0'
/** The Wrangler cf delegates the bundle to (Appendix C row 17); `-0` admits its pre-releases. */
const CF_WRANGLER_FLOOR = '4.136.0'

/** Where `cf build` writes the evaluated Worker configuration. */
const EVALUATED_CONFIG = '.cloudflare/output/v0/workers/default/worker.config.json'

export interface CfBackendOptions {
  root: string
  cf?: CfRunner
  nodeVersion?: () => string | undefined
}

export function cfDeployBackend(options: CfBackendOptions): DeployBackend {
  const { root } = options
  const cfPackage = resolvePackageFile(root, 'cf/package.json')
  const cf = options.cf ?? appCfRunner(root, join(dirname(cfPackage ?? join(root, 'node_modules/cf/package.json')), 'bin', 'cf'))
  const nodeVersion = options.nodeVersion ?? nodeOnPathVersion

  const build = (): Read<true> => {
    // A file left by an earlier build must not pass for this evaluation.
    rmSync(join(root, EVALUATED_CONFIG), { force: true })
    return cfBuild(cf)
  }

  return {
    kind: 'cf',
    outputDir: CF_OUTPUT_DIR,
    appliesNested: true,
    preflight() {
      const problems: string[] = []
      if (!cfPackage) {
        problems.push('cf is declared but not installed. Run `bun install`.')
      }
      const node = nodeVersion()
      if (!node || !Bun.semver.satisfies(node, `>=${NODE_FLOOR}`)) {
        problems.push(`cf loads cloudflare.config.ts with the node on PATH, which needs Node ${NODE_FLOOR} or later; found ${node ?? 'no node'}.`)
      }
      const wrangler = installedVersion(root, 'wrangler')
      if (!wrangler || !Bun.semver.satisfies(wrangler, `>=${CF_WRANGLER_FLOOR}-0`)) {
        problems.push(`cf bundles through the app's Wrangler, which needs ${CF_WRANGLER_FLOOR} or later; found ${wrangler ?? 'none'}. Run \`bun add -d wrangler@latest\`.`)
      }
      if (problems.length === 0) {
        const auth = checkAuth(cf)
        if (!auth.ok) {
          problems.push(`cf is not logged in (${auth.reason}). Run \`bunx cf auth login\`, or set CLOUDFLARE_API_TOKEN in CI.`)
        }
      }
      return problems
    },
    evaluate() {
      const built = build()
      if (!built.ok) {
        throw new Error(`Cloudflare deploy: \`cf build\` failed, so cloudflare.config.ts could not be evaluated:\n${built.reason}`)
      }
      return readEvaluatedWorker(root)
    },
    migrationsBinding() {
      return { ok: true, value: readWorkerManifest(join(root, CF_OUTPUT_DIR)).d1?.binding }
    },
    prepareReads() {},
    list: (type) => (type === 'd1' ? listD1Databases(cf) : listKvNamespaces(cf)),
    create: (type, name) => (type === 'd1' ? createD1Database(cf, name) : createKvNamespace(cf, name)),
    rebuild(resolved) {
      // gurenWorker() reads the manifest inside `cf build`, so only cf builds again.
      const rebuilt = build()
      if (!rebuilt.ok) return { ok: false, reason: `\`cf build\` failed after the resources were settled:\n${rebuilt.reason}` }
      const worker = readEvaluatedWorker(root)
      const drift = Object.entries(resolved)
        .filter(([binding, resource]) => worker.env[binding]?.id !== resource.id)
        .map(([binding]) => binding)
      return drift.length > 0
        ? { ok: false, reason: `cloudflare.config.ts binds ${drift.join(', ')} to another resource than the plan resolved. Remove the id it sets after the gurenWorker() spread, then plan again.` }
        : { ok: true, value: true }
    },
    applyArgs: (layout) => migrationDirArgs(layout, `${CF_OUTPUT_DIR}/d1-migrations`),
    readTracker: (database) => readMigrationTracker(cf, database.id),
    bookmark: (database) => getBookmark(cf, database.id),
    applyMigrations: (database, applyArgs) => applyMigrations(cf, database.id, applyArgs),
    listSecrets: (worker) => listWorkerSecrets(cf, worker),
    deploy: (secretsFile) => deployPrebuilt(cf, secretsFile),
    restoreCommand: (database, bookmark) => `bunx cf d1 time-travel restore ${database.id} --bookmark ${bookmark}`,
    deleteCommand: (resource) => (resource.type === 'd1'
      ? `bunx cf d1 delete ${resource.id}`
      : `bunx cf kv namespaces delete ${resource.id}`),
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
  const triggers = Array.isArray(config.triggers) ? config.triggers : []
  return { name: config.name, env, scheduled: triggers.some((trigger) => isRecord(trigger) && trigger.type === 'scheduled') }
}

/** Resolved the way Node resolves it from the app, so a hoisted workspace install is found. */
export function resolvePackageFile(root: string, specifier: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, root)
  } catch {
    return undefined
  }
}

export function installedVersion(root: string, name: string): string | undefined {
  const path = resolvePackageFile(root, `${name}/package.json`)
  const manifest = path ? readJson(path) : undefined
  return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined
}

function nodeOnPathVersion(): string | undefined {
  try {
    const result = Bun.spawnSync({ cmd: ['node', '--version'], stdout: 'pipe', stderr: 'pipe' })
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
