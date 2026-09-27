/**
 * The plans half of the docs viewer's payload (RFC 0030 §7, the docs viewer amendment): every
 * plan not closed at its current hash, with its approval, its derived steps and their records.
 * Plan JSON, approvals, the decision log, `.guren/plans/` and the files a record fingerprinted
 * only: the payload is rebuilt on a poll, so nothing here imports the application.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { toPosixRelative } from './discovery'
import { discoverPlanFiles } from './plan-check'
import { readPlanFile } from './plan-render'
import { readPlanApprovalStanding } from './plan/approvals'
import { planDocClosedHash, planDocPath, touchedModels } from './plan/close-docs'
import { planHash } from './plan/identity'
import { hasBaseline, type Plan } from './plan/schema'
import { planDigest, planSlug, readPlanState, type PlanStepRecord } from './plan/state'
import { describePlanTask, derivePlanTasks, listPlanSteps } from './plan/tasks'
import { hashFiles, readPlanWaivers, recordDrift, recordStillHolds } from './plan/verification'

export type DocsViewerPlanStanding = 'draft' | 'approved' | 'unapproved' | 'baseline-removed' | 'unreadable'

/**
 * `outdated`: a record taken against another version of the plan, which counts for nothing now.
 * `waiver-withdrawn`: verified here, over a waiver the decision log does not hold.
 */
export type DocsViewerStepState = 'verified' | 'drifted' | 'failed' | 'blocked' | 'incomplete' | 'outdated' | 'waiver-withdrawn' | 'not-run'

export interface DocsViewerPlanStep {
  id: string
  task: string
  kind: string
  state: DocsViewerStepState
  ranAt?: string
  /** `drifted` only: the fingerprinted files that changed since the step verified. */
  changed?: string[]
  /** The step `plan:next` marked, which the Stop hook verifies on every stop. */
  active?: boolean
  stall?: { at: string; reason: string }
}

export interface DocsViewerOpenPlan {
  slug: string
  /** App-relative, POSIX separators. */
  file: string
  title: string
  standing: DocsViewerPlanStanding
  /** Why the plan cannot be judged or approved as it stands. */
  reason?: string
  approval?: { at: string; by?: string }
  /** The models it adds, alters or renames. */
  entities: string[]
  steps: DocsViewerPlanStep[]
  waivers: Array<{ elementId: string; reason: string; at: string; by?: string }>
  /** `.guren/plans/<slug>.state.json` or the decision log would not read. */
  unreadable?: string[]
  /** The commands the records say come next, in order; a reading of them, not `plan:next`'s decision. */
  next: string[]
  /** `plan:status` for what the viewer does not read: element states and freshness. */
  status: string
}

export interface DocsViewerPlans {
  open: DocsViewerOpenPlan[]
  /** The current hash of every readable plan, by app-relative file; `null` for a draft. */
  hashes: Map<string, string | null>
}

/** A plan command as the reader will paste it, the file quoted for a POSIX shell where it needs it. */
export function planCommand(subcommand: string, file: string): string {
  const word = /^[\w./@-]+$/u.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`
  return `bunx guren ${subcommand} ${word}`
}

function stepState(record: PlanStepRecord | undefined, digest: string, holds: boolean, changed: string[]): DocsViewerStepState {
  if (record === undefined) return 'not-run'
  if (holds) return 'verified'
  if (changed.length > 0) return 'drifted'
  if (record.planDigest !== digest) return 'outdated'
  return record.outcome === 'verified' ? 'waiver-withdrawn' : record.outcome
}

/** The hash the plan's closing doc names; a doc that exists and will not read throws, as `readOpenPlan()` refuses it. */
async function closedHash(appRoot: string, slug: string): Promise<string | undefined> {
  try {
    return planDocClosedHash(await readFile(join(appRoot, planDocPath(slug)), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${planDocPath(slug)} could not be read: ${(error as Error).message}`)
  }
}

/** Each file hashed once per payload, however many plans' records fingerprint it. */
function fileHasher(appRoot: string): (files: string[]) => Promise<Map<string, string | null>> {
  const cache = new Map<string, Promise<string | null>>()
  return async (files) => {
    const missing = files.filter((file) => !cache.has(file))
    if (missing.length > 0) {
      const read = hashFiles(appRoot, missing)
      for (const file of missing) cache.set(file, read.then((hashes) => hashes.get(file) ?? null))
    }
    return new Map(await Promise.all(files.map(async (file) => [file, await cache.get(file)!] as const)))
  }
}

function unreadablePlan(file: string, slug: string, reason: string): DocsViewerOpenPlan {
  return { slug, file, title: file, standing: 'unreadable', reason, entities: [], steps: [], waivers: [], next: [], status: planCommand('plan:status', file) }
}

interface PlanReadContext {
  appRoot: string
  apiOnly: boolean
  hash: (files: string[]) => Promise<Map<string, string | null>>
}

async function readViewerPlan(context: PlanReadContext, path: string, file: string, slug: string): Promise<{ open?: DocsViewerOpenPlan; hash?: string | null }> {
  const { appRoot, apiOnly } = context
  const command = (subcommand: string): string => planCommand(subcommand, file)
  const plan = (await readPlanFile(path, appRoot)).plan
  const hash = hasBaseline(plan) ? planHash(plan) : null
  // A revision approved after the close carries another hash, and is open work again.
  if (hash !== null && (await closedHash(appRoot, slug)) === hash) return { hash }

  const standingRead = await readPlanApprovalStanding(path, plan)
  const standing: DocsViewerPlanStanding = standingRead?.state ?? 'draft'
  const digest = planDigest(plan)
  const [stateRead, log] = await Promise.all([readPlanState(appRoot, slug), readPlanWaivers(path, plan)])
  const records = stateRead.state?.steps ?? {}
  const hashes = await context.hash(Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))
  const active = stateRead.state?.active?.plan === file ? stateRead.state.active : undefined
  // plan:next drops an approval stall once the gate passes, so an approved plan's is already answered.
  const stalled = active?.stalled && !(active.stalled.cause === 'approval' && standingRead?.state === 'approved') ? active.stalled : undefined

  const steps = listPlanSteps(derivePlanTasks(plan, { apiOnly })).map(({ task, step }): DocsViewerPlanStep => {
    const record = records[step.id]
    const holds = record !== undefined && recordStillHolds(record, digest, hashes, log.waived)
    const changed = record && !holds ? recordDrift(record, digest, hashes, log.waived) : []
    const marked = active?.step === step.id
    return {
      id: step.id,
      task: describePlanTask(task.title),
      kind: step.kind,
      state: stepState(record, digest, holds, changed),
      ...(record ? { ranAt: record.ranAt } : {}),
      ...(changed.length > 0 ? { changed } : {}),
      ...(marked ? { active: true } : {}),
      ...(marked && stalled ? { stall: { at: stalled.at, reason: stalled.reason } } : {}),
    }
  })

  let next: string[] = []
  let reason: string | undefined
  if (standingRead === undefined) next = [command('plan:render'), command('plan:approve')]
  else if (standingRead.state === 'unapproved') next = [command('plan:approve')]
  else if (standingRead.state === 'approved') next = [command(steps.every((step) => step.state === 'verified') ? 'plan:close' : 'plan:next')]
  else if (standingRead.state === 'baseline-removed') {
    reason = `The plan has no baseline, but ${standingRead.approvals} approval(s) are recorded beside it: restore the baseline, keep the new draft in a file of its own, or approve it again.`
    next = [command('plan:approve')]
  } else reason = `The approvals beside the plan cannot be read, so it counts as approved by no one: ${standingRead.reason}`

  const unreadable = [stateRead.unreadable, log.unreadable].filter((entry): entry is string => entry !== undefined)
  return {
    hash,
    open: {
      slug,
      file,
      title: plan.title,
      standing,
      ...(reason ? { reason } : {}),
      ...(standingRead?.state === 'approved'
        ? { approval: { at: standingRead.approval.approvedAt, ...(standingRead.approval.approvedBy ? { by: standingRead.approval.approvedBy } : {}) } }
        : {}),
      entities: touchedModels(plan as Plan).map((model) => model.name),
      steps,
      waivers: [...log.waivers.values()].map(({ elementId, reason: why, at, by }) => ({ elementId, reason: why, at, ...(by ? { by } : {}) })),
      ...(unreadable.length > 0 ? { unreadable } : {}),
      next,
      status: command('plan:status'),
    },
  }
}

export async function readViewerPlans(appRoot: string): Promise<DocsViewerPlans> {
  const { files } = await discoverPlanFiles(appRoot)
  if (files.length === 0) return { open: [], hashes: new Map() }
  const context: PlanReadContext = { appRoot, apiOnly: await isConfirmedApiOnlyApp(appRoot).catch(() => false), hash: fileHasher(appRoot) }
  // One plan the readers choke on is that plan's problem, never the whole payload's.
  const read = await Promise.all(
    files.map(async (path) => {
      const file = toPosixRelative(appRoot, path)
      const slug = planSlug(path)
      const entry: { open?: DocsViewerOpenPlan; hash?: string | null } = await readViewerPlan(context, path, file, slug).catch((error: unknown) => ({
        open: unreadablePlan(file, slug, (error as Error).message),
      }))
      return { file, ...entry }
    }),
  )
  const hashes = new Map<string, string | null>()
  for (const entry of read) if (entry.hash !== undefined) hashes.set(entry.file, entry.hash)
  return { open: read.flatMap((entry) => (entry.open ? [entry.open] : [])), hashes }
}
