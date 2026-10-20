/**
 * `guren cloudflare:deploy` (RFC 0035 §1): preflight, assemble and plan, then,
 * unless `--plan`, create, rebuild, migrate, deploy and report. Nothing is written
 * to the account before the plan has no blocker and the run is confirmed, and
 * nothing is ever deleted: a failure reports what this run created instead.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import {
  ALLOW_DESTRUCTIVE_ENV,
  judgePendingMigrations,
  readEnvFileKeys,
  readRequiredDeployEnv,
} from '@guren/core/internal/deploy-plan'

import { detectCloudflareBackend, isRecord } from '../backend'
import { buildCloudflareOutput, readResolvedResources, readWorkerManifest } from '../build'
import { WORKER_MANIFEST_FILE, type ResolvedResource } from '../worker-manifest'
import { cfDeployBackend, wranglerDeployBackend, type DeployBackend } from './backends'
import type { CliRunner, Read } from './cf-cli'
import { decideLayout, fingerprintMigrations, readLocalMigrations } from './migrations'
import { formatPlan } from './report'
import { BACKEND_WORDS } from './words'
import {
  buildPlan,
  hasBlocker,
  type DeployPlan,
  type EvaluatedWorker,
  type MigrationInput,
  type PlannedBinding,
  type SecretsInput,
} from './plan'

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
  /** Seams for tests: the `cf` and `wrangler` runners, the version of `node` on PATH, and whether a person is at the terminal. */
  cf?: CliRunner
  wrangler?: CliRunner
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
  backend: DeployBackend
  databaseBinding: string | undefined
}

export async function planCloudflareDeploy(options: CloudflareDeployOptions): Promise<DeployPlan> {
  return (await prepare({ ...options, plan: true })).plan
}

async function prepare(options: CloudflareDeployOptions): Promise<Prepared> {
  const root = resolve(options.root)
  const backend = detectCloudflareBackend(root) === 'cf'
    ? cfDeployBackend({ root, cf: options.cf, nodeVersion: options.nodeVersion })
    : wranglerDeployBackend({ root, wrangler: options.wrangler, nodeVersion: options.nodeVersion })
  const problems = backend.preflight()
  if (problems.length > 0) {
    throw new Error(`Cloudflare deploy: preflight failed, before anything was built:\n  ${problems.join('\n  ')}`)
  }

  await withStdoutLogs(options.logToStderr === true, () =>
    buildCloudflareOutput({
      rootDir: root,
      skipAppBuild: options.skipAppBuild,
      mcpOAuth: options.mcpOAuth,
      ...(options.mcpPath ? { mcpPath: options.mcpPath } : {}),
      appBuildToStderr: options.logToStderr,
    }))

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY)
  const worker = backend.evaluate()
  const uses = (type: string) => Object.values(worker.env).some((entry) => entry.type === type)
  const unlisted: Read<never[]> = { ok: true, value: [] }
  const outDir = join(root, backend.outputDir)
  const previous = readWorkerManifest(outDir)
  const context = {
    backend: backend.kind,
    worker,
    manifest: {
      resolved: readResolvedResources(outDir),
      ...(isRecord(previous.resourceNames) ? { resourceNames: previous.resourceNames } : {}),
    },
    d1: uses('d1') ? backend.list('d1') : unlisted,
    kv: uses('kv') ? backend.list('kv') : unlisted,
    mayCreate: Boolean(options.provision) || (!options.ci && (interactive || Boolean(options.yes))),
  }
  // Bindings first: the migrations read the database the plan resolved the build's D1 binding to.
  const bindings = buildPlan(context).bindings
  const chosen = backend.migrationsBinding()
  backend.prepareReads(bindings)
  const databaseBinding = chosen.ok ? chosen.value : undefined
  const database = bindings.find((binding) => binding.binding === databaseBinding)
  const plan = buildPlan({
    ...context,
    ...(process.env.GITHUB_ACTIONS === 'true' ? { workflow: readRunningWorkflow(root) } : {}),
    ...(typeof previous.scheduleUnreadable === 'string' ? { scheduleUnreadable: previous.scheduleUnreadable } : {}),
    migrations: options.skipMigrations
      ? undefined
      : !chosen.ok
        ? unchosenDatabase(root, chosen.reason)
        : database ? readMigrations(root, backend, database, options) : undefined,
    secrets: await readSecrets(backend, worker, options.secretsFile, root),
  })
  return { plan, interactive, root, backend, databaseBinding }
}

/** No D1 binding could be picked for `db/migrations`: a blocker only when there is something to apply. */
function unchosenDatabase(root: string, reason: string): MigrationInput | undefined {
  const local = readLocalMigrations(join(root, 'db', 'migrations'))
  return local.folders.length === 0 && local.files.length === 0 ? undefined : { status: 'unassigned', reason }
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
  const { plan, root, backend, databaseBinding } = prepared
  const result: DeployResult = { plan, created: [] }
  const fail = (stage: string, message: string, bookmark?: { binding: string; id: string; name: string; value: string }): DeployResult => ({
    ...result,
    failure: {
      stage,
      message,
      cleanup: [
        ...(bookmark ? [BACKEND_WORDS[backend.kind].restore(bookmark, bookmark.value)] : []),
        ...result.created.map((resource) => BACKEND_WORDS[backend.kind].delete(resource)),
      ],
    },
  })

  // Stage 4: create what is missing, then settle every binding's identity in the manifest.
  const resolved: Record<string, ResolvedResource> = {}
  for (const binding of plan.bindings) {
    let id = binding.id
    if (binding.action === 'create') {
      const created = backend.create(binding.type, binding.name)
      if (!created.ok) {
        return fail('provision', `${created.reason}. If the resource was created anyway, the next plan finds it by name and adopts it.`)
      }
      id = created.value
      result.created.push({ binding: binding.binding, type: binding.type, name: binding.name, id })
    }
    if (id && !binding.configured) resolved[binding.binding] = binding.type === 'd1' ? { id, name: binding.name } : { id }
  }
  const outDir = join(root, backend.outputDir)
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

    // Stage 5: skipped when stage 4 changed nothing, since stage 3's build already binds the same ids.
    const rebuilt = backend.rebuild(resolved)
    if (!rebuilt.ok) return fail('build', rebuilt.reason)
  }

  // Stage 6: judged at the plan; applied only if the pending set is still that one.
  const migrations = plan.migrations
  const planned = plan.bindings.find((binding) => binding.binding === databaseBinding)
  const databaseId = databaseBinding ? resolved[databaseBinding]?.id ?? planned?.id : undefined
  let restore: { binding: string; id: string; name: string; value: string } | undefined
  if (!options.skipMigrations && migrations && migrations.pending.length > 0 && planned && databaseId) {
    const database = { ...planned, action: 'existing' as const, id: databaseId }
    const bookmark = backend.bookmark(database)
    if (!bookmark.ok) return fail('migrate', `${bookmark.reason}. No migration was applied without a point to restore to.`)
    // Read again the way the plan read it; the fingerprint covers the names, their order and their text.
    const now = readMigrations(root, backend, database, options)
    if (now?.status !== 'ready' || now.layout !== migrations.layout || now.fingerprint !== migrations.fingerprint) {
      return fail('migrate', now?.status === 'unreadable'
        ? `${now.reason}. Nothing was applied.`
        : 'The pending migrations changed since the plan judged them, by another run or an edit. Nothing was applied; plan again.')
    }
    restore = { binding: planned.binding, id: databaseId, name: planned.name, value: bookmark.value }
    const applied = backend.applyMigrations(database, migrations.applyArgs)
    if (!applied.ok) return fail('migrate', applied.reason, restore)
    result.migrated = { applied: migrations.pending, bookmark: bookmark.value }
  }

  const deployed = backend.deploy(options.secretsFile ? resolve(options.secretsFile) : undefined)
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
  backend: DeployBackend,
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
    const read = backend.readTracker({ ...database, id: database.id })
    if (!read.ok) return { status: 'unreadable', reason: read.reason }
    tracker = read.value
  }

  const decision = decideLayout(local, tracker, backend.appliesNested)
  if (!decision.ok) {
    return 'unsupported' in decision
      ? { status: 'layout-unsupported', nested: decision.nested }
      : { status: 'layout-conflict', nested: decision.nested, flat: decision.flat }
  }

  let verdict
  try {
    verdict = judgePendingMigrations(migrationsDir, decision.pendingFolders, 'db/migrations')
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  return {
    status: 'ready',
    layout: decision.layout,
    applyArgs: backend.applyArgs(decision.layout),
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
  backend: DeployBackend,
  worker: EvaluatedWorker,
  secretsFile: string | undefined,
  root: string,
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
    deployed: needsDeployed ? backend.listSecrets(worker.name) : { ok: true, value: [] },
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
