/**
 * The plan's decision log (RFC 0030 §6, §9): the waivers `plan:waive` writes and the
 * overlay reads. It lives beside the plan and is committed, unlike `.guren/plans/`: a
 * waiver is a person's decision about an approved plan, not a result a machine can
 * rebuild. A waiver names the plan hash it was taken against, so a revision does not
 * inherit it. A log that will not read is never replaced, which is what a record of
 * decisions costs over a cache.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { z } from 'zod'

import { CliError, formatSchemaIssues } from '../cli-error'
import { planHash } from './identity'
import { hasBaseline } from './render'
import type { Plan, PlanDraft } from './schema'

export const PLAN_DECISIONS_VERSION = 1

const PlanWaiverSchema = z.object({
  elementId: z.string(),
  /** {@link planWaiverHash} of the plan the waiver was taken against. */
  planHash: z.string(),
  reason: z.string(),
  at: z.string(),
  /** Whoever `git config` named, where it answered. */
  by: z.string().optional(),
})

export const PlanDecisionsSchema = z.object({
  decisionsVersion: z.literal(PLAN_DECISIONS_VERSION),
  waivers: z.array(PlanWaiverSchema),
})

export type PlanWaiver = z.infer<typeof PlanWaiverSchema>
export type PlanDecisions = z.infer<typeof PlanDecisionsSchema>

export interface PlanDecisionsRead {
  decisions: PlanDecisions | undefined
  /** Set when a file exists and would not read; `decisions` is then `undefined`. */
  unreadable?: string
}

/**
 * The §9 layout (`docs/plans/<slug>/plan.json`) keeps its decisions beside the plan as
 * `decisions.json`; a plan named for its slug keeps them under that name, so two plans in
 * one directory do not share a log.
 */
export function planDecisionsPath(planPath: string): string {
  const name = basename(planPath)
  if (name === 'plan.json') return join(dirname(planPath), 'decisions.json')
  return join(dirname(planPath), `${name.replace(/(\.plan)?\.json$/u, '')}.decisions.json`)
}

/**
 * The hash a waiver names, or `undefined` for a draft. A waiver is a decision about an
 * approved plan, and a draft has no identity to take one against.
 */
export function planWaiverHash(plan: PlanDraft | Plan): string | undefined {
  return hasBaseline(plan) ? planHash(plan) : undefined
}

/** Absent is `decisions: undefined` with no reason; a file that exists and does not parse says why. */
export async function readPlanDecisions(planPath: string): Promise<PlanDecisionsRead> {
  const path = planDecisionsPath(planPath)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { decisions: undefined }
    return { decisions: undefined, unreadable: `${path} could not be read: ${(error as Error).message}` }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return { decisions: undefined, unreadable: `${path} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = PlanDecisionsSchema.safeParse(document)
  if (!parsed.success) return { decisions: undefined, unreadable: `${path} does not match the decision log schema:\n${formatSchemaIssues(parsed.error)}` }
  return { decisions: parsed.data }
}

/** Element ids a log waives at `hash`, and the waivers of another hash, which lift nothing. */
export function waivedElements(decisions: PlanDecisions | undefined, hash: string | undefined): { waived: Set<string>; stale: PlanWaiver[] } {
  const waived = new Set<string>()
  const stale: PlanWaiver[] = []
  for (const waiver of decisions?.waivers ?? []) {
    if (hash !== undefined && waiver.planHash === hash) waived.add(waiver.elementId)
    else stale.push(waiver)
  }
  return { waived, stale }
}

/**
 * Read-modify-write of the log beside `planPath`. A log that would not read is refused
 * rather than replaced: it is a committed record of decisions people took, and a run that
 * overwrites it destroys them where a state file would only lose a result it can redo.
 */
async function updatePlanDecisions(planPath: string, mutate: (decisions: PlanDecisions) => void): Promise<string> {
  const read = await readPlanDecisions(planPath)
  if (read.unreadable) {
    throw new CliError(`${read.unreadable}\nThe decision log is a committed record, so this command will not replace it. Fix the file, then run this again.`)
  }
  const decisions: PlanDecisions = read.decisions ?? { decisionsVersion: PLAN_DECISIONS_VERSION, waivers: [] }
  mutate(decisions)
  // Sorted, so two runs over one log write the same bytes into the same commit.
  decisions.waivers.sort((left, right) => (left.elementId < right.elementId ? -1 : left.elementId > right.elementId ? 1 : 0))
  const path = planDecisionsPath(planPath)
  await writeFile(path, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8')
  return path
}

/** One waiver per element: a second one replaces it, and the replaced one is returned. */
export async function writePlanWaiver(planPath: string, waiver: PlanWaiver): Promise<{ path: string; replaced?: PlanWaiver }> {
  let replaced: PlanWaiver | undefined
  const path = await updatePlanDecisions(planPath, (decisions) => {
    replaced = decisions.waivers.find((candidate) => candidate.elementId === waiver.elementId)
    decisions.waivers = [...decisions.waivers.filter((candidate) => candidate.elementId !== waiver.elementId), waiver]
  })
  return { path, ...(replaced ? { replaced } : {}) }
}

/** Removes the waiver of one element, whatever hash it names; absent is not an error. */
export async function removePlanWaiver(planPath: string, elementId: string): Promise<{ path: string; removed?: PlanWaiver }> {
  let removed: PlanWaiver | undefined
  const path = await updatePlanDecisions(planPath, (decisions) => {
    removed = decisions.waivers.find((candidate) => candidate.elementId === elementId)
    decisions.waivers = decisions.waivers.filter((candidate) => candidate.elementId !== elementId)
  })
  return { path, ...(removed ? { removed } : {}) }
}
