/**
 * The backend interface `cloudflare:deploy` runs its stages against (RFC 0035 §7).
 * Every operation on the account or a CLI goes through one of these, so the stages
 * in `deploy.ts` are written once. Which backend runs is `detectCloudflareBackend()`'s.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isRecord, type CloudflareBackend } from '../backend'
import { readWorkerManifest, readWranglerConfig } from '../build'
import { D1_MIGRATIONS_DIR, outputDirFor, WRANGLER_DEPLOY_CONFIG_FILE, type ResolvedResource } from '../worker-manifest'
import {
  applyMigrations,
  appCliRunner,
  cfBuild,
  checkAuth,
  createD1Database,
  createKvNamespace,
  createR2Bucket,
  deployPrebuilt,
  getBookmark,
  listD1Databases,
  listKvNamespaces,
  listR2Buckets,
  listWorkerSecrets,
  readMigrationTracker,
  DEFAULT_TRACKER,
  parseJson,
  type AccountResource,
  type CliRunner,
  type Read,
} from './cf-cli'
import { migrationDirArgs, type MigrationLayout } from './migrations'
import type { EvaluatedBinding, EvaluatedWorker, PlannedBinding, ResourceType } from './plan'
import {
  applyWranglerMigrations,
  checkWranglerAuth,
  createWranglerResource,
  deployWithWrangler,
  getWranglerBookmark,
  listWranglerD1,
  listWranglerKv,
  listWranglerSecrets,
  readWranglerTracker,
} from './wrangler-cli'
import {
  evaluateWranglerConfig,
  renderWranglerDeployConfig,
  wranglerMigrationsBinding,
  wranglerMigrationsTable,
} from './wrangler-config'

export interface DeployBackend {
  readonly kind: CloudflareBackend
  /** The output directory, relative to the app root, holding the build and its manifest. */
  readonly outputDir: string
  /** Problems that stop the run before anything is built; the account is asked only when the tools are there. */
  preflight(): string[]
  /** The Worker the deploy would upload, read after the assemble stage. */
  evaluate(): EvaluatedWorker
  /** The D1 binding `db/migrations` is applied to, or why none could be chosen. */
  migrationsBinding(): Read<string | undefined>
  /** Called once the bindings are planned and before any read that needs a database by its id. */
  prepareReads(bindings: readonly PlannedBinding[]): void
  /** Whether `list('r2')` can tell an existing bucket from a missing one; Wrangler prints no JSON listing. */
  readonly listsR2: boolean
  /** `names` are the planned R2 bucket names, which R2 is looked up by; D1 and KV list everything. */
  list(type: ResourceType, names: readonly string[]): Read<AccountResource[]>
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
}

/** cf refuses to load cloudflare.config.ts on older Node (RFC 0035 Appendix C row 10). */
const NODE_FLOOR = '22.18.0'
/** The Wrangler cf delegates the bundle to (Appendix C row 17); `-0` admits its pre-releases. */
const CF_WRANGLER_FLOOR = '4.136.0'

/** Where `cf build` writes the evaluated Worker configuration. */
const EVALUATED_CONFIG = '.cloudflare/output/v0/workers/default/worker.config.json'

export interface CfBackendOptions {
  root: string
  cf?: CliRunner
  nodeVersion?: () => string | undefined
}

export function cfDeployBackend(options: CfBackendOptions): DeployBackend {
  const { root } = options
  const cfPackage = resolvePackageFile(root, 'cf/package.json')
  const cf = options.cf ?? appCliRunner(root, join(dirname(cfPackage ?? join(root, 'node_modules/cf/package.json')), 'bin', 'cf'))
  const nodeVersion = options.nodeVersion ?? nodeOnPathVersion

  const build = (): Read<true> => {
    // A file left by an earlier build must not pass for this evaluation.
    rmSync(join(root, EVALUATED_CONFIG), { force: true })
    return cfBuild(cf)
  }

  return {
    kind: 'cf',
    outputDir: outputDirFor('cf'),
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
      return { ok: true, value: readWorkerManifest(join(root, outputDirFor('cf'))).d1?.binding }
    },
    prepareReads() {},
    listsR2: true,
    list: (type, names) => (type === 'd1' ? listD1Databases(cf) : type === 'kv' ? listKvNamespaces(cf) : listR2Buckets(cf, names)),
    create: (type, name) => (type === 'd1' ? createD1Database(cf, name) : type === 'kv' ? createKvNamespace(cf, name) : createR2Bucket(cf, name)),
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
    applyArgs: (layout) => migrationDirArgs(layout, `${outputDirFor('cf')}/${D1_MIGRATIONS_DIR}`),
    readTracker: (database) => readMigrationTracker(cf, database.id),
    bookmark: (database) => getBookmark(cf, database.id),
    applyMigrations: (database, applyArgs) => applyMigrations(cf, database.id, applyArgs),
    listSecrets: (worker) => listWorkerSecrets(cf, worker),
    deploy: (secretsFile) => deployPrebuilt(cf, secretsFile),
  }
}

/** The Wrangler Appendix B's commands were verified against; `-0` admits its pre-releases. */
const WRANGLER_FLOOR = '4.129.0'

export interface WranglerBackendOptions {
  root: string
  wrangler?: CliRunner
  nodeVersion?: () => string | undefined
}

/**
 * For apps on `wrangler.jsonc` (RFC 0035 §7). wrangler.jsonc stays the developer's:
 * the deploy reads it, and renders `.cloudflare/wrangler.deploy.json` with the
 * resolved ids for every command that needs a database or the upload.
 */
export function wranglerDeployBackend(options: WranglerBackendOptions): DeployBackend {
  const { root } = options
  const wranglerPackage = resolvePackageFile(root, 'wrangler/package.json')
  const wrangler = options.wrangler
    ?? appCliRunner(root, join(dirname(wranglerPackage ?? join(root, 'node_modules/wrangler/package.json')), 'bin', 'wrangler.js'))
  const nodeVersion = options.nodeVersion ?? nodeOnPathVersion
  const outputDir = outputDirFor('wrangler')
  const outDir = join(root, outputDir)
  const flatDir = join(outDir, D1_MIGRATIONS_DIR)
  const configArgs = ['-c', `${outputDir}/${WRANGLER_DEPLOY_CONFIG_FILE}`]
  let config: Record<string, unknown> | undefined
  let chosen: Read<string | undefined> | undefined

  const developerConfig = (): Record<string, unknown> => {
    config ??= readWranglerConfig(join(root, 'wrangler.jsonc'))
    if (!config) throw new Error(`Cloudflare deploy: ${join(root, 'wrangler.jsonc')} is missing or not valid JSONC, so the bindings could not be read.`)
    return config
  }
  const migrationsBinding = (): Read<string | undefined> => (chosen ??= wranglerMigrationsBinding(developerConfig(), root, flatDir))
  const render = (resolved: Readonly<Record<string, ResolvedResource>>): void => {
    const binding = migrationsBinding()
    const rendered = renderWranglerDeployConfig({
      root,
      config: developerConfig(),
      resolved,
      migrationsBinding: binding.ok ? binding.value : undefined,
      flatDir,
    })
    writeFileSync(join(outDir, WRANGLER_DEPLOY_CONFIG_FILE), `${JSON.stringify(rendered, null, 2)}\n`)
  }

  return {
    kind: 'wrangler',
    outputDir,
    appliesNested: false,
    preflight() {
      const problems: string[] = []
      const manifest = wranglerPackage ? readJson(wranglerPackage) : undefined
      const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined
      if (!version || !Bun.semver.satisfies(version, `>=${WRANGLER_FLOOR}-0`)) {
        problems.push(`The deploy runs the app's Wrangler, which needs ${WRANGLER_FLOOR} or later; found ${version ?? 'none'}. Run \`bun add -d wrangler@latest\`.`)
      }
      const nodeRange = isRecord(manifest) && isRecord(manifest.engines) && typeof manifest.engines.node === 'string' ? manifest.engines.node : undefined
      const node = nodeRange ? nodeVersion() : undefined
      if (nodeRange && (!node || !Bun.semver.satisfies(node, nodeRange))) {
        problems.push(`Wrangler runs on the node on PATH, and this one needs Node ${nodeRange}; found ${node ?? 'no node'}.`)
      }
      if (problems.length === 0) {
        const auth = checkWranglerAuth(wrangler)
        if (!auth.ok) {
          problems.push(`Wrangler is not logged in (${auth.reason}). Run \`bunx wrangler login\`, or set CLOUDFLARE_API_TOKEN in CI.`)
        }
      }
      return problems
    },
    evaluate: () => evaluateWranglerConfig(developerConfig()),
    migrationsBinding,
    prepareReads(bindings) {
      const ids: Record<string, ResolvedResource> = {}
      for (const binding of bindings) {
        if (binding.id) ids[binding.binding] = { id: binding.id }
      }
      render(ids)
    },
    listsR2: false,
    list: (type) => (type === 'd1' ? listWranglerD1(wrangler) : type === 'kv' ? listWranglerKv(wrangler) : { ok: false, reason: 'wrangler r2 bucket list prints no JSON' }),
    create: (type, name) => (type === 'r2' ? { ok: false, reason: 'the Wrangler backend never creates an R2 bucket' } : createWranglerResource(wrangler, type, name)),
    rebuild(resolved) {
      render(resolved)
      return { ok: true, value: true }
    },
    applyArgs: () => ['--remote', ...configArgs],
    readTracker: (database) => readWranglerTracker(
      wrangler,
      database.binding,
      wranglerMigrationsTable(developerConfig(), database.binding) ?? DEFAULT_TRACKER,
      configArgs,
    ),
    bookmark: (database) => getWranglerBookmark(wrangler, database.binding, configArgs),
    applyMigrations: (database, applyArgs) => applyWranglerMigrations(wrangler, database.binding, applyArgs),
    listSecrets: (worker) => listWranglerSecrets(wrangler, worker, configArgs),
    deploy: (secretsFile) => deployWithWrangler(wrangler, configArgs, secretsFile),
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
function resolvePackageFile(root: string, specifier: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, root)
  } catch {
    return undefined
  }
}

function installedVersion(root: string, name: string): string | undefined {
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

function readJson(path: string): unknown {
  try {
    return parseJson(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
