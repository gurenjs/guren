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
}

/**
 * An element its step verified is `verified` while every fingerprinted file still hashes
 * the same, `drifted` once one does not or cannot be read. Lifted: an element at its
 * completion state or `unjudged`; one existing in files only when the record covers them,
 * since a result nothing could expire is not one. A `drop` has no file, its absence re-read
 * per status; an `unjudged` element with none rests on its step's behaviours, so it needs some.
 */
export function applyVerification(
  status: PlanStatus,
  derivation: PlanTaskDerivation,
  records: Readonly<Record<string, PlanStepRecord>>,
  digest: string,
  hashes: ReadonlyMap<string, string | null>,
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
      for (const id of step.elementIds) {
        const element = lifted.get(id)
        if (!element) continue
        const uncovered = element.files.filter((file) => !(file in recorded))
        const needsNoFiles = element.change === 'drop' || (element.state === 'unjudged' && step.acceptanceIds.length > 0)
        if (!awaitsVerification(element)) {
          element.notes.push(`${verifiedBy}, and no longer at the state that completes it.`)
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
 * Reads the plan's records under `root` and lays them over `status`. What both commands
 * report; a file that will not read lifts nothing and says so.
 */
export async function overlayVerification(
  root: string,
  planPath: string,
  plan: PlanDraft | Plan,
  status: PlanStatus,
  derivation: PlanTaskDerivation,
  /** A state file that would not read before this command replaced it, which a fresh read cannot show. */
  replacedUnreadable?: string,
): Promise<{ status: PlanStatus<PlanElementState>; verification: PlanVerificationSummary }> {
  const slug = planSlug(planPath)
  const read = await readPlanState(root, slug)
  const records = read.state?.steps ?? {}
  const files = Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files))
  const applied = applyVerification(status, derivation, records, planDigest(plan), await hashFiles(root, files))
  const unreadable = read.unreadable ?? (replacedUnreadable ? `${replacedUnreadable}; this run replaced it, and its other records are gone` : undefined)
  return {
    status: applied.status,
    verification: {
      stateFile: toPosixRelative(root, planStatePath(root, slug)),
      staleSteps: applied.staleSteps,
      ...(unreadable ? { unreadable } : {}),
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
 * Whether a verified record still stands: same plan, and every fingerprinted file hashing
 * as it did. A verified record fingerprints nothing only when the step had nothing file-shaped
 * to watch (`scaffold`, a `drop`, an element no reader finds a file for), so it stands on the
 * plan digest alone: a step that could never stand would keep the loop (§7) from ending.
 */
export function recordStillHolds(record: PlanStepRecord, digest: string, hashes: ReadonlyMap<string, string | null>): boolean {
  return record.outcome === 'verified' && record.planDigest === digest && changedFiles(record, hashes).length === 0
}
