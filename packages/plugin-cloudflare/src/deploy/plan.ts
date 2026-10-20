/**
 * Stage 3 of `cloudflare:deploy` (RFC 0035 §1.1, §3.1, §4): every binding resolved
 * once, and one list of checks over one context. Pure, so `--plan`, `--json` and
 * the later stages read the same answer. A source that could not be read is a
 * blocker of its own, never an empty listing.
 */
import type { D1Database, KvNamespace, Read } from './cf-cli'
import type { ResolvedResource, WorkerManifest } from '../worker-manifest'

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
  d1: Read<D1Database[]>
  kv: Read<KvNamespace[]>
  /** Whether this run may create what is missing: a TTY, `--yes` or `--provision`, never plain `--ci`. */
  mayCreate: boolean
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
}

export type CheckName = 'binding-conflict' | 'resource-missing' | 'source-unreadable'

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
  /** Whether the resolution differs from the manifest's, so stage 4 rewrites it and stage 5 rebuilds. */
  resolvedChanged: boolean
  /** Sources RFC 0035 §3.1 names that this version does not read yet. */
  unread: string[]
}

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
      findings.push({
        check: 'source-unreadable',
        severity: 'blocker',
        message: `${listing.reason}. Without the listing the plan cannot tell an existing resource from a missing one.`,
        fix: 'Rerun once `cf` can reach the account.',
      })
    }
  }

  return {
    worker: context.worker.name,
    bindings,
    findings,
    resolvedChanged: bindings.some((planned) => !sameResource(planned, context.manifest.resolved[planned.binding])),
    unread: ['the deployed Worker\'s bindings (RFC 0035 Open Question 9); the deploy\'s strict inheritance covers them'],
  }
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
  const resources = listing.value.map((resource) =>
    'uuid' in resource ? { id: resource.uuid, name: resource.name } : { id: resource.id, name: resource.title })
  const byName = resources.filter((resource) => resource.name === name)
  const label = type === 'd1' ? 'D1 database' : 'KV namespace'

  if (configuredId !== undefined) {
    if (!resources.some((resource) => resource.id === configuredId)) {
      findings.push({
        check: 'resource-missing',
        severity: 'blocker',
        binding,
        message: `${binding} names the ${label} ${configuredId} in cloudflare.config.ts, and the account has none with that id.`,
        fix: `Correct the id, or remove it so the deploy uses the ${label} named "${name}".`,
      })
    }
    const other = byName.find((resource) => resource.id !== configuredId)
    if (other) {
      findings.push({
        check: 'binding-conflict',
        severity: 'blocker',
        binding,
        message: `${binding} names the ${label} ${configuredId} in cloudflare.config.ts, while the ${label} "${name}" it would otherwise resolve to is ${other.id}.`,
        fix: 'Keep one: remove the id from cloudflare.config.ts, or give the binding another name.',
      })
    }
    return { binding, type, action: 'existing', name, id: configuredId }
  }

  if (byName.length > 1) {
    findings.push({
      check: 'binding-conflict',
      severity: 'blocker',
      binding,
      message: `The account has ${byName.length} ${label}s named "${name}" (${byName.map((resource) => resource.id).join(', ')}), so the name does not decide which one ${binding} binds.`,
      fix: 'Put the intended id in cloudflare.config.ts.',
    })
    return { binding, type, action: 'unknown', name }
  }

  const found = byName[0]
  if (found) {
    return { binding, type, action: found.id === resolvedId ? 'existing' : 'adopt', name, id: found.id }
  }

  if (!context.mayCreate) {
    findings.push({
      check: 'resource-missing',
      severity: 'blocker',
      binding,
      message: `No ${label} named "${name}" exists, and this run may not create one.`,
      fix: 'Pass --provision to let a CI run create it, or create it beforehand.',
    })
  }
  return { binding, type, action: 'create', name }
}

function sameResource(planned: PlannedBinding, resolved: ResolvedResource | undefined): boolean {
  return planned.id !== undefined && planned.id === resolved?.id && (planned.type !== 'd1' || planned.name === resolved.name)
}
