/**
 * Stage 3 of `cloudflare:deploy` (RFC 0035 §1.1, §3.1, §4): every binding resolved
 * once, and one list of checks over one context. Pure, so `--plan`, `--json` and
 * the later stages read the same answer. A source that could not be read is a
 * blocker of its own, never an empty listing.
 */
import type { DeployEnvRequirement, PendingMigrationVerdict } from '@guren/core/internal/deploy-plan'

import type { WorkerManifest } from '../worker-manifest'
import type { AccountResource, Read } from './cf-cli'
import type { MigrationLayout } from './migrations'

/** One `env` entry of cf's evaluated `worker.config.json`. */
export interface EvaluatedBinding {
  type: string
  id?: string
  name?: string
}

export interface EvaluatedWorker {
  name: string
  env: Record<string, EvaluatedBinding>
}

export interface PlanContext {
  worker: EvaluatedWorker
  manifest: Pick<WorkerManifest, 'resolved'>
  d1: Read<AccountResource[]>
  kv: Read<AccountResource[]>
  /** Whether this run may create what is missing: an interactive run or `--provision`, never plain `--ci`. */
  mayCreate: boolean
  migrations?: MigrationInput
  secrets?: SecretsInput
}

/** What deploy.ts read about the D1 database's migrations; the judging itself is the ORM's. */
export type MigrationInput =
  | { status: 'unreadable'; reason: string }
  | { status: 'layout-conflict'; nested: string[]; flat: string[] }
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

export type ResourceType = 'd1' | 'kv'

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
  /** The id came from cloudflare.config.ts, which stays its source: the manifest does not record it. */
  configured?: true
}

export type CheckName =
  | 'binding-conflict'
  | 'resource-missing'
  | 'source-unreadable'
  | 'tracker-layout'
  | 'destructive-migration'
  | 'secrets'

export interface Finding {
  check: CheckName
  severity: 'blocker' | 'warning'
  binding?: string
  message: string
  fix?: string
}

export interface DeployPlan {
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

/** Bindings cf's provisioning would create under `<worker>-<binding>`, with `_` as `-` (RFC 0035 §4). */
export function autoProvisionedName(worker: string, binding: string): string {
  return `${worker}-${binding.toLowerCase().replaceAll('_', '-')}`
}

export function buildPlan(context: PlanContext): DeployPlan {
  const findings: Finding[] = []
  const bindings: PlannedBinding[] = []

  for (const [binding, entry] of Object.entries(context.worker.env)) {
    if (entry.type !== 'd1' && entry.type !== 'kv') continue
    const planned = planBinding(context, binding, entry, entry.type, findings)
    bindings.push(planned)
  }

  for (const [type, listing] of [['d1', context.d1], ['kv', context.kv]] as const) {
    if (!listing.ok && bindings.some((planned) => planned.type === type)) {
      findings.push(blocker(
        'source-unreadable',
        undefined,
        `${listing.reason}. Without the listing the plan cannot tell an existing resource from a missing one.`,
        'Rerun once `cf` can reach the account.',
      ))
    }
  }

  const migrations = context.migrations ? planMigrations(context.migrations, findings) : undefined
  const missingSecrets = context.secrets ? planSecrets(context.secrets, context.worker.name, findings) : undefined

  return {
    worker: context.worker.name,
    bindings,
    findings,
    ...(migrations ? { migrations } : {}),
    ...(missingSecrets ? { missingSecrets } : {}),
    unread: UNREAD_SOURCES,
  }
}

function planMigrations(input: MigrationInput, findings: Finding[]): DeployPlan['migrations'] {
  if (input.status === 'unreadable') {
    findings.push(blocker('source-unreadable', undefined, `${input.reason}. Without the tracker the plan cannot tell which migrations are pending.`, 'Rerun once `cf` can query the database.'))
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

function planSecrets(input: SecretsInput, worker: string, findings: Finding[]): string[] | undefined {
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
      ? missing.map((name) => `bunx cf workers secrets update ${name} --worker ${worker}`).join('; ')
      : `List them in a dotenv file passed as --secrets-file${input.secretsFile ? ` (${input.secretsFile} lacks them)` : ''}; only the names are read here.`,
  ))
  return missing
}

export function hasBlocker(plan: DeployPlan): boolean {
  return plan.findings.some((finding) => finding.severity === 'blocker')
}

function planBinding(
  context: PlanContext,
  binding: string,
  entry: EvaluatedBinding,
  type: ResourceType,
  findings: Finding[],
): PlannedBinding {
  // KV cannot carry a name (`bindings.kv()` takes only an id), so its name is always the provisioning default.
  const name = type === 'd1' && entry.name ? entry.name : autoProvisionedName(context.worker.name, binding)
  const resolvedId = context.manifest.resolved[binding]?.id
  // An id equal to the manifest's came from gurenWorker(), which is a comparison, not a source.
  const configuredId = entry.id !== undefined && entry.id !== resolvedId ? entry.id : undefined

  const listing = type === 'd1' ? context.d1 : context.kv
  if (!listing.ok) {
    return { binding, type, action: 'unknown', name, ...(configuredId ? { id: configuredId } : {}) }
  }
  const resources = listing.value
  const byName = resources.filter((resource) => resource.name === name)
  const label = type === 'd1' ? 'D1 database' : 'KV namespace'

  if (configuredId !== undefined) {
    const missing = !resources.some((resource) => resource.id === configuredId)
    if (missing) {
      findings.push(blocker(
        'resource-missing',
        binding,
        `${binding} names the ${label} ${configuredId} in cloudflare.config.ts, and the account has none with that id.`,
        `Correct the id, or remove it so the deploy uses the ${label} named "${name}".`,
      ))
    }
    const other = byName.find((resource) => resource.id !== configuredId)
    if (other) {
      findings.push(blocker(
        'binding-conflict',
        binding,
        `${binding} names the ${label} ${configuredId} in cloudflare.config.ts, while the ${label} "${name}" it would otherwise resolve to is ${other.id}.`,
        'Keep one: remove the id from cloudflare.config.ts, or give the binding another name.',
      ))
    }
    return { binding, type, action: missing ? 'unknown' : 'existing', name, id: configuredId, configured: true }
  }

  // gurenWorker() puts the manifest's id in the config, so the deploy binds it while it exists.
  if (resolvedId !== undefined && resources.some((resource) => resource.id === resolvedId)) {
    const other = byName.find((resource) => resource.id !== resolvedId)
    if (other && !byName.some((resource) => resource.id === resolvedId)) {
      findings.push(blocker(
        'binding-conflict',
        binding,
        `${binding} is bound to the ${label} ${resolvedId} by an earlier deploy, while the ${label} "${name}" is ${other.id}.`,
        `Put the intended id in cloudflare.config.ts, or rename one of the ${label}s.`,
      ))
    }
    return { binding, type, action: 'existing', name, id: resolvedId }
  }

  if (byName.length > 1) {
    findings.push(blocker(
      'binding-conflict',
      binding,
      `The account has ${byName.length} ${label}s named "${name}" (${byName.map((resource) => resource.id).join(', ')}), so the name does not decide which one ${binding} binds.`,
      'Put the intended id in cloudflare.config.ts.',
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
