/**
 * Recorded verification laid over a `plan:status` result (RFC 0030 §6): the fingerprint
 * arithmetic, and the one reading of `.guren/plans/` both `plan:status` and `plan:verify`
 * report through, so the two commands cannot disagree about what a record lifts. Nothing
 * here executes anything; `verify.ts` is what runs the commands.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { toPosixRelative } from '../discovery'
import { planDecisionsPath, planWaiverHash, readPlanDecisions, type PlanDecisions, type PlanWaiver } from './decisions'
import type { Plan, PlanDraft } from './schema'
import { planDigest, planSlug, planStatePath, readPlanState, type PlanStepRecord } from './state'
import { awaitsVerification, summarize, type PlanElementState, type PlanElementStatus, type PlanStatus } from './status'
import type { PlanTaskDerivation } from './tasks'

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** App-relative path → hash, or `null` for a file that cannot be read, which a record keeps as such. */
export async function hashFiles(root: string, files: Iterable<string>): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>()
  for (const file of new Set(files)) {
    try {
      hashes.set(file, sha256(await readFile(resolve(root, file))))
    } catch {
      hashes.set(file, null)
    }
  }
  return hashes
}

export interface PlanVerificationSummary {
  /** Relative to the application root, POSIX separators; it need not exist. */
  stateFile: string
  /** Steps whose record ran against another plan or revision, so it lifted nothing. */
  staleSteps: string[]
  /** Set when a state file exists and could not be read, which lifts nothing either. */
  unreadable?: string
  /** The decision log beside the plan, relative to the application root; it need not exist. */
  decisionsFile: string
  /** Waivers taken against another plan or revision, so they lift nothing. */
  staleWaivers: PlanWaiver[]
  /** Set when a decision log exists and could not be read. */
  decisionsUnreadable?: string
}

/**
 * The elements the behaviours `acceptanceIds` exercise, read off the plan (RFC 0030 §6): the
 * route each targets, the action it dispatches to and that action's controller, the validators,
 * policy and response it names, and the view a behaviour or that response renders with the
 * resources its props name. Nothing in a plan links a behaviour to a job, event or listener.
 */
export function behaviourReach(plan: PlanDraft | Plan, acceptanceIds: readonly string[]): Set<string> {
  const reached = new Set<string>()
  const wanted = new Set(acceptanceIds)
  const routes = new Map(plan.routes.map((route) => [route.id, route]))
  const actions = new Map(plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, { controller, action }] as const)))
  const views = new Map(plan.views.map((view) => [view.id, view]))
  const reachView = (id: string): void => {
    reached.add(id)
    for (const prop of views.get(id)?.props ?? []) if (prop.resource) reached.add(prop.resource)
  }

  for (const behaviour of plan.tasks.flatMap((task) => task.acceptance)) {
    if (!wanted.has(behaviour.id)) continue
    reached.add(behaviour.route)
    if (behaviour.expect.inertia) reachView(behaviour.expect.inertia)
    const route = routes.get(behaviour.route)
    if (!route) continue
    for (const binding of route.bind) reached.add(binding.model)
    const found = actions.get(route.action)
    if (!found) continue
    const { controller, action } = found
    for (const id of [route.action, controller.id, action.params, action.query, action.body, action.authorization.policy?.id]) if (id) reached.add(id)
    if (action.response.kind === 'inertia') reachView(action.response.view)
    if (action.response.kind === 'resource') reached.add(action.response.resource)
  }
  return reached
}

/**
 * An element its step verified is `verified` while every fingerprinted file still hashes the
 * same, `drifted` once one does not or cannot be read. Lifted: one at its completion state or
 * `unjudged`, in files the record covers, since a result nothing could expire is not one. A
 * `drop` has no file, its absence re-read per status. One no property of which matched lifts
 * only while a verified step of its task ran behaviours that reach it.
 */
export function applyVerification(
  status: PlanStatus,
  derivation: PlanTaskDerivation,
  records: Readonly<Record<string, PlanStepRecord>>,
  digest: string,
  hashes: ReadonlyMap<string, string | null>,
  plan: PlanDraft | Plan,
): { status: PlanStatus<PlanElementState>; staleSteps: string[] } {
  const lifted = new Map<string, PlanElementStatus<PlanElementState>>(status.elements.map((element) => [element.id, { ...element, notes: [...element.notes] }]))
  const staleSteps: string[] = []

  for (const task of derivation.tasks) {
    for (const step of task.steps) {
      const record = records[step.id]
      if (!record || record.outcome !== 'verified') continue
      if (record.planDigest !== digest) {
        staleSteps.push(step.id)
        continue
      }
      const recorded = record.fingerprint.files
      const changed = changedFiles(record, hashes)
      const verifiedBy = `Verified ${record.ranAt} by ${step.id}`
      // A split step's earlier parts carry no behaviours: the task's last work step runs them all.
      const carriers = task.steps.filter((candidate) => {
        if (candidate.kind === 'tests' || candidate.acceptanceIds.length === 0) return false
        if (candidate === step) return true
        const carried = records[candidate.id]
        return carried?.outcome === 'verified' && carried.planDigest === digest && changedFiles(carried, hashes).length === 0
      })
      const reached = behaviourReach(plan, carriers.flatMap((carrier) => carrier.acceptanceIds))
      for (const id of step.elementIds) {
        const element = lifted.get(id)
        if (!element) continue
        const uncovered = element.files.filter((file) => !(file in recorded))
        const unread = element.change !== 'drop' && !element.properties.some((property) => property.verdict === 'match')
        // Past the reach test an `unjudged` element is one a behaviour exercised, whose test files a standing record covers.
        const needsNoFiles = element.change === 'drop' || element.state === 'unjudged'
        if (!awaitsVerification(element)) {
          element.notes.push(`${verifiedBy}, and no longer at the state that completes it.`)
        } else if (unread && !reached.has(id)) {
          element.notes.push(`${verifiedBy}, and no planned property of it was read and no verified behaviour of its task reaches it, so that result is not counted.`)
        } else if (element.files.length === 0 && !needsNoFiles) {
          element.notes.push(`${verifiedBy}, and nothing of it was fingerprinted, so that result could not expire and is not counted.`)
        } else if (uncovered.length > 0) {
          element.state = 'drifted'
          element.notes.push(`${verifiedBy}; now in a file that run did not fingerprint: ${uncovered.join(', ')}.`)
        } else if (changed.length === 0) {
          element.state = 'verified'
        } else {
          element.state = 'drifted'
          element.notes.push(`${verifiedBy}; changed since: ${changed.join(', ')}.`)
        }
      }
    }
  }

  const elements = [...lifted.values()]
  return { status: { elements, summary: summarize(elements) }, staleSteps }
}

/**
 * A waiver lifts an element to `waived` whatever the readers found, since a person accepted
 * it incomplete (RFC 0030 §6). Two elements keep their state, with a note saying the waiver
 * is not needed: one its step verified, a stronger answer than acceptance, and an `existing`
 * one, which the plan changes nothing about and which `plan:waive` refuses. The second is
 * reached only through a hand-edited log.
 */
export function applyWaivers(status: PlanStatus<PlanElementState>, waivers: ReadonlyMap<string, PlanWaiver>): PlanStatus<PlanElementState> {
  if (waivers.size === 0) return status
  const elements = status.elements.map((element): PlanElementStatus<PlanElementState> => {
    const waiver = waivers.get(element.id)
    if (!waiver) return element
    const taken = `Waived ${waiver.at}${waiver.by ? ` by ${waiver.by}` : ''}: ${waiver.reason}`
    if (element.state === 'verified') return { ...element, notes: [...element.notes, `${taken}. It is verified, so the waiver is not needed.`] }
    if (element.change === 'existing') return { ...element, notes: [...element.notes, `${taken}. It is an existing element, no part of completion, so the waiver is not needed.`] }
    return { ...element, state: 'waived', notes: [...element.notes, taken] }
  })
  return { elements, summary: summarize(elements) }
}

/** The waivers of `decisions` that name this plan, by element id, and the ones that do not. */
export function planWaivers(plan: PlanDraft | Plan, decisions: PlanDecisions | undefined): { waivers: Map<string, PlanWaiver>; stale: PlanWaiver[] } {
  const hash = planWaiverHash(plan)
  const waivers = new Map<string, PlanWaiver>()
  const stale: PlanWaiver[] = []
  for (const waiver of decisions?.waivers ?? []) {
    if (hash === undefined || waiver.planHash !== hash) stale.push(waiver)
    else if (!waivers.has(waiver.elementId)) waivers.set(waiver.elementId, waiver)
  }
  return { waivers, stale }
}

export interface PlanWaiversRead {
  waivers: Map<string, PlanWaiver>
  /** The ids of `waivers`, for the callers that ask nothing else of them. */
  waived: Set<string>
  stale: PlanWaiver[]
  unreadable?: string
}

/** The log beside the plan, matched against it: what a command asks for the ids a waiver covers. */
export async function readPlanWaivers(planPath: string, plan: PlanDraft | Plan): Promise<PlanWaiversRead> {
  const log = await readPlanDecisions(planPath)
  const { waivers, stale } = planWaivers(plan, log.decisions)
  return { waivers, waived: new Set(waivers.keys()), stale, ...(log.unreadable ? { unreadable: log.unreadable } : {}) }
}

/**
 * Reads the plan's records under `root` and the decision log beside the plan, and lays both
 * over `status`. What every command reports through; a file that will not read lifts nothing
 * and says so.
 */
export async function overlayVerification(
  root: string,
  planPath: string,
  plan: PlanDraft | Plan,
  status: PlanStatus,
  derivation: PlanTaskDerivation,
  options: {
    /** A state file that would not read before this command replaced it, which a fresh read cannot show. */
    replacedUnreadable?: string
    /** The log this run already read, so a command judges and reports through one reading of it. */
    waivers?: PlanWaiversRead
  } = {},
): Promise<{ status: PlanStatus<PlanElementState>; verification: PlanVerificationSummary }> {
  const slug = planSlug(planPath)
  const read = await readPlanState(root, slug)
  const records = read.state?.steps ?? {}
  const files = Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files))
  const applied = applyVerification(status, derivation, records, planDigest(plan), await hashFiles(root, files), plan)
  const unreadable =
    read.unreadable ?? (options.replacedUnreadable ? `${options.replacedUnreadable}; this run replaced it, and its other records are gone` : undefined)
  const log = options.waivers ?? (await readPlanWaivers(planPath, plan))
  return {
    status: applyWaivers(applied.status, log.waivers),
    verification: {
      stateFile: toPosixRelative(root, planStatePath(root, slug)),
      staleSteps: applied.staleSteps,
      ...(unreadable ? { unreadable } : {}),
      decisionsFile: toPosixRelative(root, planDecisionsPath(planPath)),
      staleWaivers: log.stale,
      ...(log.unreadable ? { decisionsUnreadable: log.unreadable } : {}),
    },
  }
}

/** Fingerprinted files whose hash differs from the record's; one recorded unreadable never matches. */
function changedFiles(record: PlanStepRecord, hashes: ReadonlyMap<string, string | null>): string[] {
  return Object.entries(record.fingerprint.files)
    .filter(([file, hash]) => hash === null || hashes.get(file) !== hash)
    .map(([file]) => file)
}

/**
 * Whether a verified record still stands: same plan, every fingerprinted file hashing as it did,
 * and every element it rested on a waiver for still waived. A record fingerprints nothing only
 * where the step had nothing file-shaped to watch (`scaffold`, a `drop`, an element no reader
 * finds a file for), so it stands on the plan digest alone, or the loop (§7) could never end.
 * `waived` defaults to none, which retires a record resting on one rather than keeping it.
 */
export function recordStillHolds(record: PlanStepRecord, digest: string, hashes: ReadonlyMap<string, string | null>, waived: ReadonlySet<string> = new Set()): boolean {
  if (record.outcome !== 'verified' || record.planDigest !== digest) return false
  if (record.waived.some((id) => !waived.has(id))) return false
  return changedFiles(record, hashes).length === 0
}
