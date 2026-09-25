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
import { behaviourCanReach, behaviourCarriers } from './reach'
import type { Plan, PlanDraft } from './schema'
import { planDigest, planSlug, planStatePath, readPlanState, type PlanStepRecord, type PlanStepWork } from './state'
import { awaitsVerification, summarize, type PlanElementState, type PlanElementStatus, type PlanStatus, type PlanVerificationHold } from './status'
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
  /** Files touched and lines changed per step (RFC 0030 §7), by step id; absent when no record carries them. */
  work?: Record<string, PlanStepWork>
}

/**
 * Whether a verified step lifts the element only while a verified behaviour reaches it (RFC 0030
 * §6): no planned property of it matched beyond an existence (`existence`: a key a validator or
 * resource declares, an ability a policy names), which says nothing of the planned shape or rule.
 * The one rule the overlay and `plan:close`'s remedies ask. A `drop` is re-read on every status.
 */
export function restsOnReach(element: Pick<PlanElementStatus<PlanElementState>, 'change' | 'properties'>): boolean {
  return element.change !== 'drop' && !element.properties.some((property) => property.verdict === 'match' && !property.existence)
}

/**
 * Whether nothing of the element can be fingerprinted: no reader found a file of it, and it is
 * neither a `drop` (no file to have) nor `unjudged` (resting on the behaviours reaching
 * it, whose test files their record covers). No run or added behaviour lifts such an element.
 */
export function cannotFingerprint(element: Pick<PlanElementStatus<PlanElementState>, 'change' | 'state' | 'files'>): boolean {
  return element.files.length === 0 && element.change !== 'drop' && element.state !== 'unjudged'
}

/**
 * An element its step verified is `verified` while every fingerprinted file still hashes the
 * same, `drifted` once one does not or cannot be read. Lifted: one at its completion state or
 * `unjudged`, in files the record covers, since a result nothing could expire is not one. A
 * `drop` has no file, its absence re-read per status. An element for which `restsOnReach()` holds
 * is lifted only while a behaviour of a standing step, in any task, reaches it.
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

  // A carrier in any task counts: one task's behaviour may render a page or return a resource another task placed.
  const carriers = behaviourCarriers(plan, derivation)
  const standing = new Set(
    Object.entries(records)
      .filter(([, record]) => recordStands(record, digest, hashes))
      .map(([stepId]) => stepId),
  )
  const reachable = behaviourCanReach(plan)
  const unreached = (element: PlanElementStatus<PlanElementState>): string => {
    const reaching = carriers.get(element.id) ?? []
    if (reaching.length === 0 && !reachable.has(element.id)) return 'no verified behaviour reaches it, so that result is not counted: no behaviour can reach it, so waive it'
    const steps = `no verified run of a step whose behaviours reach it (${reaching.join(', ')}) holds now`
    // Neither a carrier's run nor a behaviour added to the plan would lift it, so neither is suggested.
    if (cannotFingerprint(element)) {
      return `${reaching.length > 0 ? steps : 'no verified behaviour reaches it'}, and plan:verify cannot fingerprint it, so that result is not counted: waive it`
    }
    if (reaching.length > 0) return `${steps}, so that result is not counted: run plan:verify on ${reaching.length === 1 ? 'that step' : 'one of those steps'}, or waive it`
    return 'no verified behaviour reaches it, so that result is not counted: add a behaviour that reaches it, or waive it'
  }

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
      for (const id of step.elementIds) {
        const element = lifted.get(id)
        if (!element) continue
        const uncovered = element.files.filter((file) => !(file in recorded))
        const unmatched = restsOnReach(element)
        const hold = (kind: PlanVerificationHold, note: string): void => {
          element.notes.push(note)
          element.hold = { kind, note }
        }
        // `reason` is why the readers left it `unjudged`; the lifted state and its hold carry their own account.
        const settle = (state: 'verified' | 'drifted'): void => {
          element.state = state
          delete element.reason
        }
        if (!awaitsVerification(element)) {
          hold('incomplete', `${verifiedBy}, and no longer at the state that completes it.`)
        } else if (unmatched && !(carriers.get(id) ?? []).some((stepId) => standing.has(stepId))) {
          hold('unreached', `${verifiedBy}, but no planned property of it matched beyond its existence and ${unreached(element)}.`)
        } else if (cannotFingerprint(element)) {
          hold('unfingerprinted', `${verifiedBy}, and nothing of it was fingerprinted, so that result could not expire and is not counted.`)
        } else if (uncovered.length > 0) {
          settle('drifted')
          hold('expired', `${verifiedBy}; now in a file that run did not fingerprint: ${uncovered.join(', ')}.`)
        } else if (changed.length > 0) {
          settle('drifted')
          hold('expired', `${verifiedBy}; changed since: ${changed.join(', ')}.`)
        } else {
          settle('verified')
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
    const { hold: _hold, reason: _reason, ...rest } = element
    return { ...rest, state: 'waived', notes: [...element.notes, taken] }
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
  const work = Object.entries(records).flatMap(([stepId, record]) => (record.work ? [[stepId, record.work] as const] : []))
  return {
    status: applyWaivers(applied.status, log.waivers),
    verification: {
      stateFile: toPosixRelative(root, planStatePath(root, slug)),
      staleSteps: applied.staleSteps,
      ...(unreadable ? { unreadable } : {}),
      decisionsFile: toPosixRelative(root, planDecisionsPath(planPath)),
      staleWaivers: log.stale,
      ...(log.unreadable ? { decisionsUnreadable: log.unreadable } : {}),
      ...(work.length > 0 ? { work: Object.fromEntries(work) } : {}),
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
  return recordStands(record, digest, hashes) && record.waived.every((id) => waived.has(id))
}

/**
 * The fingerprinted files that changed since a record was verified, when they are all that keeps
 * it from standing: the step was done, and a later step wrote into a file it watched. Its verify
 * commands are re-run then, not the step re-implemented. Empty for a record that stands or fails
 * {@link recordStillHolds} for any other reason.
 */
export function recordDrift(record: PlanStepRecord, digest: string, hashes: ReadonlyMap<string, string | null>, waived: ReadonlySet<string> = new Set()): string[] {
  if (record.outcome !== 'verified' || record.planDigest !== digest || !record.waived.every((id) => waived.has(id))) return []
  return changedFiles(record, hashes)
}

/** Verified against this plan digest, every fingerprinted file hashing as it did: what a record must be to count at all. */
export function recordStands(record: PlanStepRecord, digest: string, hashes: ReadonlyMap<string, string | null>): boolean {
  return record.outcome === 'verified' && record.planDigest === digest && changedFiles(record, hashes).length === 0
}
