/**
 * Stage 3 of `cloudflare:deploy` (RFC 0035 §1.1, §3.1, §4): every binding resolved
 * once, and one list of checks over one context. Pure, so `--plan`, `--json` and
 * the later stages read the same answer. A source that could not be read is a
 * blocker of its own, never an empty listing.
 */
import type { DeployEnvRequirement, PendingMigrationVerdict } from '@guren/core/internal/deploy-plan'

import type { CloudflareBackend } from '../backend'
import type { BindingInference } from '../inference'
import { resourceName, type WorkerManifest } from '../worker-manifest'
import type { AccountResource, Read } from './cf-cli'
import type { MigrationLayout } from './migrations'
import { BACKEND_WORDS, type BackendWords } from './words'

/** One `env` entry of cf's evaluated `worker.config.json`. */
export interface EvaluatedBinding {
  type: string
  id?: string
  name?: string
}

export interface EvaluatedWorker {
  name: string
  env: Record<string, EvaluatedBinding>
  /** Whether the evaluated config has a scheduled trigger. */
  scheduled?: boolean
}

export interface PlanContext {
  /** Which CLI and config file the findings name. */
  backend: CloudflareBackend
  worker: EvaluatedWorker
  manifest: Pick<WorkerManifest, 'resolved'> & Partial<Pick<WorkerManifest, 'resourceNames'>>
  d1: Read<AccountResource[]>
  kv: Read<AccountResource[]>
  /** R2 buckets by name; absent when the backend cannot list them, which leaves R2 bindings to the deploy. */
  r2?: Read<AccountResource[]>
  /** What the build learnt from the app as Workers runs it (`buildCloudflareOutput()`'s result). */
  inference?: BindingInference
  /** Whether this run may create what is missing: an interactive run or `--provision`, never plain `--ci`. */
  mayCreate: boolean
  migrations?: MigrationInput
  secrets?: SecretsInput
  /** In GitHub Actions: the running workflow's text, or why it could not be read. */
  workflow?: Read<string>
  /** The build could not read the schedule kernel (WorkerManifest.scheduleUnreadable). */
  scheduleUnreadable?: string
}

/** What deploy.ts read about the D1 database's migrations; the judging itself is the ORM's. */
export type MigrationInput =
  | { status: 'unreadable'; reason: string }
  | { status: 'layout-conflict'; nested: string[]; flat: string[] }
  /** The config does not say which D1 binding `db/migrations` belongs to. */
  | { status: 'unassigned'; reason: string }
  /** The tracker holds nested names, which this backend cannot apply. */
  | { status: 'layout-unsupported'; nested: string[] }
  | {
    status: 'ready'
    layout: MigrationLayout
    /** The `cf d1 migrations apply` arguments after the database id. */
    applyArgs: string[]
    pending: string[]
    /** Pending plain `.sql` files, which the guard cannot judge. */
    unjudged: string[]
    verdict: PendingMigrationVerdict
    allowDestructive: boolean
    /** sha256 over the pending files as judged; the apply stage refuses a change. */
    fingerprint: string
  }

export interface SecretsInput {
  required: DeployEnvRequirement
  deployed: Read<string[]>
  /** Names the evaluated config binds as values, and names `--secrets-file` assigns. */
  provided: string[]
  secretsFile?: string
}

export type ResourceType = 'd1' | 'kv' | 'r2'

/**
 * - `existing`: the resource the manifest already resolved, or the id the config names.
 * - `adopt`: found under the planned name and not yet resolved. Possibly another project's.
 * - `create`: nothing under the planned name.
 * - `unknown`: a source could not be read.
 */
export type BindingAction = 'existing' | 'adopt' | 'create' | 'unknown'

export interface PlannedBinding {
  binding: string
  type: ResourceType
  action: BindingAction
  /** The name looked up, and created under when missing. */
  name: string
  /** Absent until the resource exists. */
  id?: string
  /** The id came from the config file (cloudflare.config.ts, wrangler.jsonc), which stays its source: the manifest does not record it. */
  configured?: true
}

export type CheckName =
  | 'binding-conflict'
  | 'resource-missing'
  | 'resource-name'
  | 'source-unreadable'
  | 'tracker-layout'
  | 'destructive-migration'
  | 'secrets'
  | 'serialization'
  | 'schedule-unreadable'

export interface Finding {
  check: CheckName
  severity: 'blocker' | 'warning'
  binding?: string
  message: string
  fix?: string
}

export interface DeployPlan {
  backend: CloudflareBackend
  worker: string
  bindings: PlannedBinding[]
  findings: Finding[]
  migrations?: {
    layout: MigrationLayout
    pending: string[]
    applyArgs: string[]
    acknowledged: PendingMigrationVerdict['acknowledged']
    fingerprint: string
  }
  /** Required names neither the deployed Worker, the config nor `--secrets-file` provides. */
  missingSecrets?: string[]
  /** Sources RFC 0035 §3.1 names that this version does not read yet. */
  unread: string[]
}

const UNREAD_SOURCES = [
  'the deployed Worker\'s bindings (RFC 0035 Open Question 9); the deploy\'s strict inheritance covers them',
]

/** The concurrency group `guren deploy --target cloudflare` writes for a Worker; @guren/cli's template spells it too. */
export function deployConcurrencyGroup(worker: string): string {
  return `cloudflare-deploy-${worker}`
}

/** A top-level `concurrency` that queues a second run rather than cancelling the first. */
function serializesRuns(workflow: string): boolean {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(workflow)
  } catch {
    return false
  }
  const concurrency = typeof parsed === 'object' && parsed !== null ? (parsed as { concurrency?: unknown }).concurrency : undefined
  if (typeof concurrency === 'string') return concurrency.trim() !== ''
  if (typeof concurrency !== 'object' || concurrency === null) return false
  const { group, 'cancel-in-progress': cancel } = concurrency as { group?: unknown; 'cancel-in-progress'?: unknown }
  return typeof group === 'string' && group.trim() !== '' && cancel !== true
}

export function buildPlan(context: PlanContext): DeployPlan {
  const { backend } = context
  const words = BACKEND_WORDS[backend]
  const findings: Finding[] = []
  const bindings: PlannedBinding[] = []

  for (const [binding, entry] of Object.entries(context.worker.env)) {
    const type = entry.type as ResourceType
    if (!(type in RESOURCES) || !listingFor(context, type)) continue
    bindings.push(planBinding(context, binding, entry, type, findings, words))
  }
  for (const planned of bindings) {
    const problem = planned.configured ? undefined : RESOURCES[planned.type].nameProblem?.(planned.name)
    if (problem) {
      findings.push(blocker(
        'resource-name',
        planned.binding,
        `"${planned.name}" is not a valid ${RESOURCES[planned.type].label} name: ${problem}.`,
        `Name it in config/cloudflare.ts (resourceNames: { ${planned.binding}: '<name>' }), or correct the name ${words.config} gives it, which comes first.`,
      ))
    }
  }
  for (const binding of Object.keys(context.manifest.resourceNames ?? {})) {
    const bound = context.worker.env[binding]
    if (bound && bound.type in RESOURCES) continue
    findings.push({
      check: 'resource-name',
      severity: 'warning',
      binding,
      message: bound
        ? `config/cloudflare.ts names a resource for ${binding}, a ${bound.type} binding, which has no resource to name, so the name is not used.`
        : `config/cloudflare.ts names a resource for ${binding}, which the Worker does not bind, so the name is not used.`,
      fix: `Check the binding's spelling: the Worker binds ${Object.keys(context.worker.env).join(', ') || 'nothing'}.`,
    })
  }
  const unread = [...UNREAD_SOURCES, ...planInference(context, findings, words)]

  for (const type of Object.keys(RESOURCES) as ResourceType[]) {
    const listing = listingFor(context, type)
    if (listing && !listing.ok && bindings.some((planned) => planned.type === type)) {
      findings.push(blocker(
        'source-unreadable',
        undefined,
        `${listing.reason}. Without the listing the plan cannot tell an existing resource from a missing one.`,
        `Rerun once \`${words.cli}\` can reach the account.`,
      ))
    }
  }

  if (context.workflow && !(context.workflow.ok && serializesRuns(context.workflow.value))) {
    findings.push({
      check: 'serialization',
      severity: 'warning',
      message: context.workflow.ok
        ? 'This GitHub Actions workflow has no top-level concurrency group that waits for a running deploy, so two deploys of this Worker can overlap, or one can be cancelled midway through a migration.'
        : `The running workflow could not be read (${context.workflow.reason}), so whether deploys of this Worker run one at a time is unknown.`,
      fix: `Add \`concurrency: { group: ${deployConcurrencyGroup(context.worker.name)}, cancel-in-progress: false }\` at the top of the workflow, as \`guren deploy --target cloudflare\` writes it.`,
    })
  }

  if (context.scheduleUnreadable && !context.worker.scheduled) {
    findings.push(blocker(
      'schedule-unreadable',
      undefined,
      `${context.scheduleUnreadable}, so whether the Worker needs a cron trigger is unknown, and deploying without one would remove a trigger it may already have.`,
      'Fix the kernel so `bunx guren schedule:list` reads it, or set `triggers` yourself in cloudflare.config.ts.',
    ))
  }

  const migrations = context.migrations ? planMigrations(context.migrations, findings, words) : undefined
  const missingSecrets = context.secrets ? planSecrets(context.secrets, context.worker.name, findings, words) : undefined

  return {
    backend,
    worker: context.worker.name,
    bindings,
    findings,
    ...(migrations ? { migrations } : {}),
    ...(missingSecrets ? { missingSecrets } : {}),
    unread,
  }
}

/** The bindings the app names but the Worker lacks, and what could not be inferred (RFC 0035 §2). */
function planInference(context: PlanContext, findings: Finding[], words: BackendWords): string[] {
  const { inference, worker } = context
  if (!inference) return []
  const unread: string[] = []
  if (inference.unread) unread.push(`the bindings the app names (R2 disks, the D1 binding): ${inference.unread}`)
  if (inference.opaqueDisks?.length) {
    unread.push(`the disks ${inference.opaqueDisks.join(', ')}, registered with a bare factory; register an R2 disk with r2Disk() so the deploy sees its bucket`)
  }
  for (const binding of inference.r2Buckets) {
    if (worker.env[binding]?.type === 'r2') continue
    const bucket = resourceName(worker.name, binding, context.manifest.resourceNames)
    findings.push(blocker(
      'resource-missing',
      binding,
      `A storage disk reads the R2 bucket binding ${binding}, which the Worker does not bind, so its first file operation would throw.`,
      words.addR2(binding, bucket),
    ))
  }
  const database = inference.databaseBinding
  const bound = database ? worker.env[database] : undefined
  if (database && bound?.type !== 'd1') {
    findings.push(blocker(
      bound ? 'binding-conflict' : 'resource-missing',
      database,
      bound
        ? `config/database.ts reads the D1 binding ${database}, which the Worker binds as ${bound.type}.`
        : `config/database.ts reads the D1 binding ${database}, which the Worker does not bind.`,
      words.addD1(database),
    ))
  }
  return unread
}

function planMigrations(input: MigrationInput, findings: Finding[], words: BackendWords): DeployPlan['migrations'] {
  if (input.status === 'unreadable') {
    findings.push(blocker('source-unreadable', undefined, `${input.reason}. Without the tracker the plan cannot tell which migrations are pending.`, `Rerun once \`${words.cli}\` can query the database.`))
    return undefined
  }
  if (input.status === 'unassigned') {
    findings.push(blocker(
      'tracker-layout',
      undefined,
      `${input.reason}.`,
      `Set "migrations_dir": ".cloudflare/d1-migrations" on that binding in ${words.config}.`,
    ))
    return undefined
  }
  if (input.status === 'layout-unsupported') {
    findings.push(blocker(
      'tracker-layout',
      undefined,
      `d1_migrations records drizzle's nested names (${input.nested.slice(0, 3).join(', ')}), which only the cf backend applies. ${words.cli} applies the flattened copy, so it would run the whole history again.`,
      'Deploy with the cf backend (`bunx guren cloudflare:init`), or rename the rows to `<folder>.sql` with a guarded UPDATE on d1_migrations.',
    ))
    return undefined
  }
  if (input.status === 'layout-conflict') {
    findings.push(blocker(
      'tracker-layout',
      undefined,
      `d1_migrations records both flattened names (${input.flat.slice(0, 3).join(', ')}) and nested ones (${input.nested.slice(0, 3).join(', ')}), so no layout applies only what is pending.`,
      'Rename the rows to one form with a guarded UPDATE on d1_migrations, then plan again.',
    ))
    return undefined
  }

  const destructive = [
    ...input.verdict.unacknowledged,
    ...input.unjudged.map((file) => input.layout === 'nested'
      ? `db/migrations/${file}: a plain .sql file, which the nested layout never applies`
      : `db/migrations/${file}: a plain .sql file, which the destructive-migration guard does not read`),
  ]
  if (destructive.length > 0) {
    findings.push({
      check: 'destructive-migration',
      severity: input.allowDestructive ? 'warning' : 'blocker',
      message: `${destructive.length} pending statement(s) no migration acknowledges:\n    ${destructive.join('\n    ')}`,
      fix: 'Review each one. Put `-- guren:allow-destructive: <reason>` on the first line of its migration.sql, or pass --allow-destructive for this run.',
    })
  }
  return {
    layout: input.layout,
    pending: input.pending,
    applyArgs: input.applyArgs,
    acknowledged: input.verdict.acknowledged,
    fingerprint: input.fingerprint,
  }
}

function planSecrets(input: SecretsInput, worker: string, findings: Finding[], words: BackendWords): string[] | undefined {
  if (input.required.status === 'unreadable') {
    findings.push(blocker('source-unreadable', undefined, `${input.required.message}. Without it the plan cannot tell which secrets the worker needs.`, 'Fix config/env.ts so it imports, then plan again.'))
    return undefined
  }
  if (input.required.status === 'absent') return undefined

  const have = new Set([...input.provided, ...(input.deployed.ok ? input.deployed.value : [])])
  const missing = input.required.required.filter((name) => !have.has(name))
  if (missing.length === 0) return missing

  findings.push(blocker(
    'secrets',
    undefined,
    input.deployed.ok
      ? `${worker} has no value for ${missing.join(', ')}, which config/env.ts requires in production.`
      : `config/env.ts requires ${missing.join(', ')} in production, and the deployed secrets could not be read (${input.deployed.reason}), as on a first deploy.`,
    input.deployed.ok
      ? missing.map((name) => words.setSecret(name, worker)).join('; ')
      : `List them in a dotenv file passed as --secrets-file${input.secretsFile ? ` (${input.secretsFile} lacks them)` : ''}; only the names are read here.`,
  ))
  return missing
}

export function hasBlocker(plan: DeployPlan): boolean {
  return plan.findings.some((finding) => finding.severity === 'blocker')
}

/** What differs per resource type. R2 has no id: a bucket's name is its identity (`{ id: name, name }`). */
const RESOURCES: Record<ResourceType, { label: string; hasId: boolean; carriesName: boolean; nameProblem?: (name: string) => string | undefined }> = {
  d1: { label: 'D1 database', hasId: true, carriesName: true },
  kv: { label: 'KV namespace', hasId: true, carriesName: false },
  r2: {
    label: 'R2 bucket',
    hasId: false,
    carriesName: true,
    // A name R2 rejects fails the create after other resources exist (RFC 0035 §4).
    nameProblem: (name) => (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) ? undefined : '3 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit'),
  },
}

/** A type's account listing; absent for one the backend cannot list, which leaves its bindings to the deploy. */
function listingFor(context: PlanContext, type: ResourceType): Read<AccountResource[]> | undefined {
  return type === 'd1' ? context.d1 : type === 'kv' ? context.kv : context.r2
}

function planBinding(
  context: PlanContext,
  binding: string,
  entry: EvaluatedBinding,
  type: ResourceType,
  findings: Finding[],
  words: BackendWords,
): PlannedBinding {
  const resource = RESOURCES[type]
  // KV cannot carry a name (`bindings.kv()` takes only an id): config/cloudflare.ts names it, or the provisioning default does.
  const name = resourceName(context.worker.name, binding, context.manifest.resourceNames, resource.carriesName ? entry.name : undefined)
  const resolvedId = context.manifest.resolved[binding]?.id
  // An id equal to the manifest's came from gurenWorker(), which is a comparison, not a source.
  const configuredId = resource.hasId && entry.id !== undefined && entry.id !== resolvedId ? entry.id : undefined

  // buildPlan plans a type only when its listing is there.
  const listing = listingFor(context, type)!
  if (!listing.ok) {
    return { binding, type, action: 'unknown', name, ...(configuredId ? { id: configuredId } : {}) }
  }
  const resources = listing.value
  const byName = resources.filter((resource) => resource.name === name)
  const { label } = resource

  if (configuredId !== undefined) {
    const missing = !resources.some((resource) => resource.id === configuredId)
    if (missing) {
      findings.push(blocker(
        'resource-missing',
        binding,
        `${binding} names the ${label} ${configuredId} in ${words.config}, and the account has none with that id.`,
        `Correct the id, or remove it so the deploy uses the ${label} named "${name}".`,
      ))
    }
    const other = byName.find((resource) => resource.id !== configuredId)
    if (other) {
      findings.push(blocker(
        'binding-conflict',
        binding,
        `${binding} names the ${label} ${configuredId} in ${words.config}, while the ${label} "${name}" it would otherwise resolve to is ${other.id}.`,
        `Keep one: remove the id from ${words.config}, or give the binding another name.`,
      ))
    }
    return { binding, type, action: missing ? 'unknown' : 'existing', name, id: configuredId, configured: true }
  }

  // gurenWorker() puts the manifest's id in the config, so the deploy binds it while it exists. An R2
  // bucket's id is its name, so a config naming another bucket is not the settled one.
  const settled = resolvedId === undefined || (!resource.hasId && resolvedId !== name)
    ? undefined
    : resources.find((candidate) => candidate.id === resolvedId)
  if (settled) {
    // An earlier deploy pins the binding by id, so a new name in config/cloudflare.ts would be shown but not bound.
    const requested = context.manifest.resourceNames?.[binding]
    if (requested !== undefined && requested !== settled.name) {
      findings.push(blocker(
        'binding-conflict',
        binding,
        `config/cloudflare.ts names ${binding}'s ${label} "${requested}", but an earlier deploy bound it to "${settled.name}" (${settled.id}), which the next deploy would keep.`,
        `To move the binding, delete ${binding} from "resolved" in .guren/cloudflare/guren-worker.json and plan again; to stay, set the name back to "${settled.name}".`,
      ))
      return { binding, type, action: 'unknown', name: requested, id: settled.id }
    }
    const other = byName.find((resource) => resource.id !== resolvedId)
    if (other && !byName.some((resource) => resource.id === resolvedId)) {
      findings.push(blocker(
        'binding-conflict',
        binding,
        `${binding} is bound to the ${label} ${resolvedId} by an earlier deploy, while the ${label} "${name}" is ${other.id}.`,
        `Put the intended id in ${words.config}, or rename one of the ${label}s.`,
      ))
    }
    return { binding, type, action: 'existing', name, id: resolvedId }
  }

  if (byName.length > 1) {
    findings.push(blocker(
      'binding-conflict',
      binding,
      `The account has ${byName.length} ${label}s named "${name}" (${byName.map((resource) => resource.id).join(', ')}), so the name does not decide which one ${binding} binds.`,
      `Put the intended id in ${words.config}.`,
    ))
    return { binding, type, action: 'unknown', name }
  }

  const found = byName[0]
  if (found) {
    return { binding, type, action: found.id === resolvedId ? 'existing' : 'adopt', name, id: found.id }
  }

  if (!context.mayCreate) {
    findings.push(blocker(
      'resource-missing',
      binding,
      `No ${label} named "${name}" exists, and this run may not create one.`,
      'Pass --provision to let a CI run create it, or create it beforehand.',
    ))
  }
  return { binding, type, action: 'create', name }
}

function blocker(check: CheckName, binding: string | undefined, message: string, fix: string): Finding {
  return { check, severity: 'blocker', ...(binding ? { binding } : {}), message, fix }
}
