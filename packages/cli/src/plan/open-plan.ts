/**
 * Whether a plan file is open work (RFC 0030 §8): approved by the rule every gated plan command
 * reads (§4), and not closed at its current hash. `check --plan` judges the open plans, and
 * `guren check` reads the routes files their scaffold steps wrote. Plan JSON, approvals and the
 * closing document only: nothing here imports the application.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { toPosixRelative } from '../discovery'
import { readPlanFile } from '../plan-render'
import { describeUnapproved, readPlanApprovalStanding } from './approvals'
import { planDocClosedHash, planDocPath } from './close-docs'
import type { Plan } from './schema'
import { planSlug } from './state'

export interface OpenPlan {
  /** Absolute. */
  path: string
  /** App-relative, POSIX separators. */
  file: string
  plan: Plan
  /** The approved hash. */
  hash: string
}

/**
 * Skipped: a draft nobody approved, a plan changed since its approval, or one `plan:close` closed
 * at its current hash. A draft with approvals beside it lost its baseline, which is reported.
 */
export type OpenPlanReading = { kind: 'open'; plan: OpenPlan } | { kind: 'skipped' } | { kind: 'unreadable' | 'baseline-removed'; reason: string }

export async function readOpenPlan(appRoot: string, path: string): Promise<OpenPlanReading> {
  const file = toPosixRelative(appRoot, path)
  let plan: Awaited<ReturnType<typeof readPlanFile>>['plan']
  try {
    plan = (await readPlanFile(path, appRoot)).plan
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message }
  }
  const standing = await readPlanApprovalStanding(path, plan)
  if (standing === undefined || standing.state === 'unapproved') return { kind: 'skipped' }
  if (standing.state === 'unreadable') return { kind: 'unreadable', reason: standing.reason }
  if (standing.state === 'baseline-removed') return { kind: 'baseline-removed', reason: describeUnapproved(file, standing, 'it is not checked') }

  const doc = join(appRoot, planDocPath(planSlug(path)))
  let source: string | undefined
  try {
    source = await readFile(doc, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable', reason: `${doc} could not be read: ${(error as Error).message}` }
  }
  // A revision approved after the close carries another hash, and is open work again.
  if (source !== undefined && planDocClosedHash(source) === standing.hash) return { kind: 'skipped' }
  // Only a plan with a baseline has the hash an `approved` standing names.
  return { kind: 'open', plan: { path, file, plan: plan as Plan, hash: standing.hash } }
}
