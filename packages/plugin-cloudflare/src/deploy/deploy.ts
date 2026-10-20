/**
 * `guren cloudflare:deploy` (RFC 0035 §1): preflight, assemble and plan, then,
 * unless `--plan`, create, rebuild, migrate, deploy and report. Nothing is written
 * to the account before the plan has no blocker and the run is confirmed, and
 * nothing is ever deleted: a failure reports what this run created instead.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import {
  ALLOW_DESTRUCTIVE_ENV,
  judgePendingMigrations,
  readEnvFileKeys,
  readRequiredDeployEnv,
} from '@guren/core/internal/deploy-plan'

import { detectCloudflareBackend, isRecord } from '../backend'
import { buildCloudflareOutput, readResolvedResources, readWorkerManifest } from '../build'
import { CF_OUTPUT_DIR, WORKER_MANIFEST_FILE, type ResolvedResource } from '../worker-manifest'
import {
  applyMigrations,
  appCfRunner,
  cfBuild,
  createD1Database,
  createKvNamespace,
  deployPrebuilt,
  getBookmark,
  checkAuth,
  listD1Databases,
  listKvNamespaces,
  listWorkerSecrets,
  readMigrationTracker,
  type CfRunner,
  type Read,
} from './cf-cli'
import { decideLayout, fingerprintMigrations, migrationDirArgs, readLocalMigrations } from './migrations'
import { formatPlan } from './report'
import {
  buildPlan,
  hasBlocker,
  type DeployPlan,
  type EvaluatedBinding,
  type EvaluatedWorker,
  type MigrationInput,
  type PlannedBinding,
  type SecretsInput,
} from './plan'

/** cf refuses to load cloudflare.config.ts on older Node (RFC 0035 Appendix C row 10). */
const NODE_FLOOR = '22.18.0'
/** The Wrangler cf delegates the bundle to (Appendix C row 17); `-0` admits its pre-releases. */
const WRANGLER_FLOOR = '4.136.0'

/** Where `cf build` writes the evaluated Worker configuration. */
const EVALUATED_CONFIG = '.cloudflare/output/v0/workers/default/worker.config.json'

export interface CloudflareDeployOptions {
  root: string
  /** Stop after the plan, writing nothing to the account. */
  plan?: boolean
  /** Proceed without the confirmation prompt; needed by a run with no terminal that is not `--ci`. */
  yes?: boolean
  ci?: boolean
  skipMigrations?: boolean
  provision?: boolean
  mcpOAuth?: boolean
  mcpPath?: string
  skipAppBuild?: boolean
  /** Apply pending destructive statements no marker covers (also `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`). */
  allowDestructive?: boolean
  /** A dotenv file of secrets for the deploy; the plan reads only its names. */
  secretsFile?: string
  /** Route the build's own output to stderr, so stdout carries only `--json`. */
  logToStderr?: boolean
  /** Seams for tests: the `cf` runner, the version of `node` on PATH, and whether a person is at the terminal. */
  cf?: CfRunner
  nodeVersion?: () => string | undefined
  interactive?: boolean
  /** Asks once, after the plan is shown and before anything is written. */
  confirm?: (plan: DeployPlan) => Promise<boolean>
}

interface Prepared {
  plan: DeployPlan
  /** Whether a person can answer the prompt, decided once for the plan and the run. */
  interactive: boolean
  root: string
  cf: CfRunner
  databaseBinding: string | undefined
}

export async function planCloudflareDeploy(options: CloudflareDeployOptions): Promise<DeployPlan> {
  return (await prepare({ ...options, plan: true })).plan
}

async function prepare(options: CloudflareDeployOptions): Promise<Prepared> {
  const root = resolve(options.root)
  const cfBin = resolvePackageFile(root, 'cf/package.json')
  const cf = options.cf ?? appCfRunner(root, join(dirname(cfBin ?? join(root, 'node_modules/cf/package.json')), 'bin', 'cf'))
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

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY)
  const worker = readEvaluatedWorker(root)
  const uses = (type: string) => Object.values(worker.env).some((entry) => entry.type === type)
  const unlisted: Read<never[]> = { ok: true, value: [] }
  const previous = readWorkerManifest(join(root, CF_OUTPUT_DIR))
  const context = {
    worker,
    manifest: {
      resolved: readResolvedResources(join(root, CF_OUTPUT_DIR)),
      ...(isRecord(previous.resourceNames) ? { resourceNames: previous.resourceNames } : {}),
    },
    d1: uses('d1') ? listD1Databases(cf) : unlisted,
    kv: uses('kv') ? listKvNamespaces(cf) : unlisted,
    mayCreate: Boolean(options.provision) || (!options.ci && (interactive || Boolean(options.yes))),
  }
  // Bindings first: the migrations read the database the plan resolved the build's D1 binding to.
  const databaseBinding = previous.d1?.binding
  const database = buildPlan(context).bindings.find((binding) => binding.binding === databaseBinding)
  const plan = buildPlan({
    ...context,
    ...(process.env.GITHUB_ACTIONS === 'true' ? { workflow: readRunningWorkflow(root) } : {}),
    ...(typeof previous.scheduleUnreadable === 'string' ? { scheduleUnreadable: previous.scheduleUnreadable } : {}),
    migrations: database && !options.skipMigrations ? readMigrations(root, cf, database, options) : undefined,
    secrets: await readSecrets(root, cf, worker, options.secretsFile),
  })
  return { plan, interactive, root, cf, databaseBinding }
}

export interface CreatedResource {
  binding: string
  type: 'd1' | 'kv'
  name: string
  id: string
}

export interface DeployResult {
  plan: DeployPlan
  /** Where the run stopped short of deploying, and why. */
  stopped?: 'plan' | 'blocked' | 'declined'
  /** The plan was shown at the prompt, so the report need not repeat it. */
  confirmed?: true
  created: CreatedResource[]
  migrated?: { applied: string[]; bookmark: string }
  deployment?: { output: string }
  url?: string
  /** A stage after the plan failed. `cleanup` lists commands, never run here. */
  failure?: { stage: string; message: string; cleanup: string[] }
}

/** Every stage of RFC 0035 §1. Throws only before stage 4; after it, failures are reported with what to clean up. */
export async function runCloudflareDeploy(input: CloudflareDeployOptions): Promise<DeployResult> {
  // Whether a person can answer a prompt, decided once; piping the output elsewhere does not change it.
  const options = { ...input, interactive: input.interactive ?? Boolean(process.stdin.isTTY) }
  // Refused before anything is built: nobody can answer the prompt this run would need.
  if (!options.plan && !options.yes && !options.ci && !options.interactive) {
    throw new Error('Cloudflare deploy: no terminal to confirm the plan on. Pass --yes to deploy it, --ci to deploy without creating anything, or --plan to only plan.')
  }

  const prepared = await prepare(options)
  const { plan } = prepared
  if (options.plan) return { plan, stopped: 'plan', created: [] }
  if (hasBlocker(plan)) return { plan, stopped: 'blocked', created: [] }

  if (prepared.interactive && !options.yes) {
    if (!(await (options.confirm ?? confirmOnTerminal)(plan))) return { plan, stopped: 'declined', created: [] }
    return { ...(await applyPlan(prepared, options)), confirmed: true }
  }
  return applyPlan(prepared, options)
}

async function confirmOnTerminal(plan: DeployPlan): Promise<boolean> {
  console.error(formatPlan(plan))
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await prompt.question('Apply this plan to the account? [y/N] ')).trim())
  } finally {
    prompt.close()
  }
}

async function applyPlan(prepared: Prepared, options: CloudflareDeployOptions): Promise<DeployResult> {
  const { plan, root, cf, databaseBinding } = prepared
  const result: DeployResult = { plan, created: [] }
  const fail = (stage: string, message: string, bookmark?: { id: string; value: string }): DeployResult => ({
    ...result,
    failure: { stage, message, cleanup: cleanupCommands(result.created, bookmark) },
  })

  // Stage 4: create what is missing, then settle every binding's identity in the manifest.
  const resolved: Record<string, ResolvedResource> = {}
  for (const binding of plan.bindings) {
    let id = binding.id
    if (binding.action === 'create') {
      const created = binding.type === 'd1' ? createD1Database(cf, binding.name) : createKvNamespace(cf, binding.name)
      if (!created.ok) {
        return fail('provision', `${created.reason}. If the resource was created anyway, the next plan finds it by name and adopts it.`)
      }
      id = created.value
      result.created.push({ binding: binding.binding, type: binding.type, name: binding.name, id })
    }
    if (id && !binding.configured) resolved[binding.binding] = binding.type === 'd1' ? { id, name: binding.name } : { id }
  }
  const outDir = join(root, CF_OUTPUT_DIR)
  const previous = readResolvedResources(outDir)
  // A binding this build does not plan (OAUTH_KV without --mcp-oauth) keeps what an earlier deploy settled.
  const merged = { ...previous, ...resolved }
  for (const binding of plan.bindings) {
    if (binding.configured) delete merged[binding.binding]
  }
  if (!sameResolution(previous, merged)) {
    if (!writeResolved(outDir, merged)) {
      return fail('provision', `${join(outDir, WORKER_MANIFEST_FILE)} could not be read back, so the resolved ids were not recorded. Run cloudflare:build, then deploy again.`)
    }

    // Stage 5: gurenWorker() reads the manifest inside `cf build`, so only cf builds again.
    rmSync(join(root, EVALUATED_CONFIG), { force: true })
    const rebuilt = cfBuild(cf)
    if (!rebuilt.ok) return fail('build', `\`cf build\` failed after the resources were settled:\n${rebuilt.reason}`)
    const drift = boundElsewhere(readEvaluatedWorker(root), resolved)
    if (drift.length > 0) {
      return fail('build', `cloudflare.config.ts binds ${drift.join(', ')} to another resource than the plan resolved. Remove the id it sets after the gurenWorker() spread, then plan again.`)
    }
  }

  // Stage 6: judged at the plan; applied only if the pending set is still that one.
  const migrations = plan.migrations
  const databaseId = databaseBinding ? resolved[databaseBinding]?.id : undefined
  let restore: { id: string; value: string } | undefined
  if (!options.skipMigrations && migrations && migrations.pending.length > 0 && databaseId) {
    const bookmark = getBookmark(cf, databaseId)
    if (!bookmark.ok) return fail('migrate', `${bookmark.reason}. No migration was applied without a point to restore to.`)
    // Read again the way the plan read it; the fingerprint covers the names, their order and their text.
    const now = readMigrations(root, cf, { binding: databaseBinding ?? '', type: 'd1', action: 'existing', name: '', id: databaseId }, options)
    if (now?.status !== 'ready' || now.layout !== migrations.layout || now.fingerprint !== migrations.fingerprint) {
      return fail('migrate', now?.status === 'unreadable'
        ? `${now.reason}. Nothing was applied.`
        : 'The pending migrations changed since the plan judged them, by another run or an edit. Nothing was applied; plan again.')
    }
    restore = { id: databaseId, value: bookmark.value }
    const applied = applyMigrations(cf, databaseId, migrations.applyArgs)
    if (!applied.ok) return fail('migrate', applied.reason, restore)
    result.migrated = { applied: migrations.pending, bookmark: bookmark.value }
  }

  const deployed = deployPrebuilt(cf, options.secretsFile ? resolve(options.secretsFile) : undefined)
  if (!deployed.ok) return fail('deploy', deployed.reason, restore)
  result.deployment = { output: deployed.value }
  const url = /https:\/\/[^\s"'<>]+\.workers\.dev[^\s"'<>]*/.exec(deployed.value)?.[0]
  return url ? { ...result, url } : result
}

function sameResolution(before: Record<string, ResolvedResource>, after: Record<string, ResolvedResource>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].every((key) => before[key]?.id === after[key]?.id && before[key]?.name === after[key]?.name)
}

/** Replaces only `resolved`, keeping the rest of what the build wrote; false when there is no manifest to keep. */
function writeResolved(outDir: string, resolved: Record<string, ResolvedResource>): boolean {
  const manifest = readWorkerManifest(outDir)
  if (manifest.version === undefined) return false
  writeFileSync(join(outDir, WORKER_MANIFEST_FILE), `${JSON.stringify({ ...manifest, resolved }, null, 2)}\n`)
  return true
}

/** Bindings the rebuilt config points at another id than the plan settled. */
function boundElsewhere(worker: EvaluatedWorker, resolved: Record<string, ResolvedResource>): string[] {
  return Object.entries(resolved)
    .filter(([binding, resource]) => worker.env[binding]?.id !== resource.id)
    .map(([binding]) => binding)
}

function cleanupCommands(created: CreatedResource[], bookmark: { id: string; value: string } | undefined): string[] {
  return [
    ...(bookmark ? [`bunx cf d1 time-travel restore ${bookmark.id} --bookmark ${bookmark.value}`] : []),
    ...created.map((resource) => resource.type === 'd1'
      ? `bunx cf d1 delete ${resource.id}`
      : `bunx cf kv namespaces delete ${resource.id}`),
  ]
}

/** GITHUB_WORKFLOW_REF is `owner/repo/.github/workflows/<file>@<ref>`; the file is read from the checkout. */
function readRunningWorkflow(root: string): Read<string> {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? ''
  const path = /\/(\.github\/workflows\/[^@]+)@/.exec(ref)?.[1]
  if (!path) return { ok: false, reason: 'GITHUB_WORKFLOW_REF names no workflow file' }
  try {
    return { ok: true, value: readFileSync(resolve(process.env.GITHUB_WORKSPACE ?? root, path), 'utf8') }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function readMigrations(
  root: string,
  cf: CfRunner,
  database: PlannedBinding,
  options: CloudflareDeployOptions,
): MigrationInput | undefined {
  const migrationsDir = join(root, 'db', 'migrations')
  const local = readLocalMigrations(migrationsDir)
  if (local.folders.length === 0 && local.files.length === 0) return undefined
  // An unresolved binding is a blocker of its own; a database to be created has applied nothing.
  if (database.action === 'unknown') return undefined

  let tracker: string[] | null = null
  if (database.action !== 'create' && database.id) {
    const read = readMigrationTracker(cf, database.id)
    if (!read.ok) return { status: 'unreadable', reason: read.reason }
    tracker = read.value
  }

  const decision = decideLayout(local, tracker)
  if (!decision.ok) return { status: 'layout-conflict', nested: decision.nested, flat: decision.flat }

  let verdict
  try {
    verdict = judgePendingMigrations(migrationsDir, decision.pendingFolders, 'db/migrations')
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  return {
    status: 'ready',
    layout: decision.layout,
    applyArgs: migrationDirArgs(decision.layout, `${CF_OUTPUT_DIR}/d1-migrations`),
    pending: decision.pending,
    unjudged: decision.pendingFiles,
    verdict,
    fingerprint: fingerprintMigrations(migrationsDir, decision.pending),
    allowDestructive: options.allowDestructive === true || process.env[ALLOW_DESTRUCTIVE_ENV] === '1',
  }
}

/** Binding types whose value the config itself provides. A `secret` binding only declares one. */
const VALUE_BINDING_TYPES = new Set(['text', 'json'])

async function readSecrets(
  root: string,
  cf: CfRunner,
  worker: EvaluatedWorker,
  secretsFile: string | undefined,
): Promise<SecretsInput> {
  const provided = Object.entries(worker.env)
    .filter(([, entry]) => VALUE_BINDING_TYPES.has(entry.type))
    .map(([name]) => name)
  if (secretsFile) {
    let content: string
    try {
      // A path argument, so from where the command runs, as `--root` is.
      content = readFileSync(resolve(secretsFile), 'utf8')
    } catch (error) {
      throw new Error(`Cloudflare deploy: --secrets-file ${secretsFile} could not be read (${error instanceof Error ? error.message : String(error)}).`)
    }
    const keys = await readEnvFileKeys(content)
    if (typeof keys === 'string') throw new Error(`Cloudflare deploy: --secrets-file could not be read: ${keys}.`)
    provided.push(...keys)
  }

  const required = await readRequiredDeployEnv(root)
  const needsDeployed = required.status === 'loaded' && required.required.some((name) => !provided.includes(name))
  return {
    required,
    deployed: needsDeployed ? listWorkerSecrets(cf, worker.name) : { ok: true, value: [] },
    provided,
    ...(secretsFile ? { secretsFile } : {}),
  }
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
  if (!node || !Bun.semver.satisfies(node, `>=${NODE_FLOOR}`)) {
    problems.push(`cf loads cloudflare.config.ts with the node on PATH, which needs Node ${NODE_FLOOR} or later; found ${node ?? 'no node'}.`)
  }
  const wrangler = installedVersion(root, 'wrangler')
  if (!wrangler || !Bun.semver.satisfies(wrangler, `>=${WRANGLER_FLOOR}-0`)) {
    problems.push(`cf bundles through the app's Wrangler, which needs ${WRANGLER_FLOOR} or later; found ${wrangler ?? 'none'}. Run \`bun add -d wrangler@latest\`.`)
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
  const triggers = Array.isArray(config.triggers) ? config.triggers : []
  return { name: config.name, env, scheduled: triggers.some((trigger) => isRecord(trigger) && trigger.type === 'scheduled') }
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


function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

