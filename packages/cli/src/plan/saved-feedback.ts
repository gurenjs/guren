/**
 * The review feedback the Dev Center saves as the person marks the plan page (RFC 0030 §8,
 * served mode): `.guren/plans/<slug>.feedback.json`, beside the state file and ignored with it.
 * Stamped with `planDigest()`, so a draft is named as well as an approved plan, and feedback
 * given on another version of the plan is never applied to this one.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { writeFileAtomic } from './beside'
import { PlanFeedbackSchema, type PlanFeedback } from './feedback'
import { ensurePlanStateIgnored, PLAN_STATE_DIR } from './state'

export const SAVED_FEEDBACK_VERSION = 1
export const SAVED_FEEDBACK_SUFFIX = '.feedback.json'

/** What a page posts: the whole document each time, never a patch, so a lost request loses nothing a later one does not carry. */
export const SavedFeedbackPostSchema = z.object({ planDigest: z.string(), feedback: PlanFeedbackSchema })

const SavedFeedbackSchema = z.object({
  feedbackVersion: z.literal(SAVED_FEEDBACK_VERSION),
  planDigest: z.string(),
  savedAt: z.string(),
  feedback: PlanFeedbackSchema,
})

export type SavedPlanFeedback = z.infer<typeof SavedFeedbackSchema>

export function savedFeedbackPath(appRoot: string, slug: string): string {
  return join(appRoot, PLAN_STATE_DIR, `${slug}${SAVED_FEEDBACK_SUFFIX}`)
}

/** `saved` when the file reads, `unreadable` with the reason when it exists and does not; neither when there is none. */
export async function readSavedPlanFeedback(appRoot: string, slug: string): Promise<{ saved?: SavedPlanFeedback; unreadable?: string }> {
  const path = savedFeedbackPath(appRoot, slug)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { unreadable: `${PLAN_STATE_DIR}/${slug}${SAVED_FEEDBACK_SUFFIX} would not read: ${(error as Error).message}` }
  }
  try {
    const parsed = SavedFeedbackSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return { saved: parsed.data }
    return { unreadable: `${PLAN_STATE_DIR}/${slug}${SAVED_FEEDBACK_SUFFIX} is not saved review feedback.` }
  } catch {
    return { unreadable: `${PLAN_STATE_DIR}/${slug}${SAVED_FEEDBACK_SUFFIX} is not JSON.` }
  }
}

export async function writeSavedPlanFeedback(appRoot: string, slug: string, planDigest: string, feedback: PlanFeedback, now: Date = new Date()): Promise<SavedPlanFeedback> {
  const saved: SavedPlanFeedback = { feedbackVersion: SAVED_FEEDBACK_VERSION, planDigest, savedAt: now.toISOString(), feedback }
  await ensurePlanStateIgnored(appRoot)
  await writeFileAtomic(savedFeedbackPath(appRoot, slug), `${JSON.stringify(saved, null, 2)}\n`)
  return saved
}

/** What the plan list says about saved feedback without carrying the comments themselves. */
export interface SavedFeedbackSummary {
  savedAt: string
  /** False once the plan changed after the review: `plan:revise` will not apply it. */
  current: boolean
  approved: number
  changes: number
  comments: number
  answers: number
}

export function summarizeSavedFeedback(saved: SavedPlanFeedback, planDigest: string): SavedFeedbackSummary {
  const { elements, answers } = saved.feedback
  return {
    savedAt: saved.savedAt,
    current: saved.planDigest === planDigest,
    approved: elements.filter((element) => element.verdict === 'approve').length,
    changes: elements.filter((element) => element.verdict === 'changes').length,
    comments: elements.filter((element) => element.comment.trim() !== '').length,
    answers: answers.length,
  }
}
