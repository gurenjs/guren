/**
 * The review feedback the Dev Center saves as the person marks the plan page (RFC 0030 §8,
 * served mode): `.guren/plans/<slug>.feedback.json`, beside the state file and ignored with it.
 * Stamped with `planDigest()`, so a draft is named as well as an approved plan, and feedback
 * given on another version of the plan is never applied to this one.
 */

import { join } from 'node:path'

import { z } from 'zod'

import { readBesideRecord, writeFileAtomic } from './beside'
import { PlanFeedbackSchema, type PlanFeedback } from './feedback'
import { ensurePlanStateIgnored, PLAN_STATE_DIR } from './state'

/** What a page posts: the whole document each time, never a patch, so a lost request loses nothing a later one does not carry. */
export const SavedFeedbackPostSchema = z.object({ planDigest: z.string(), feedback: PlanFeedbackSchema })

const SavedFeedbackSchema = SavedFeedbackPostSchema.extend({ feedbackVersion: z.literal(1), savedAt: z.string() })

export type SavedPlanFeedback = z.infer<typeof SavedFeedbackSchema>

/** The file relative to the app root, POSIX separators: what the commands and the pages name. */
export function savedFeedbackFile(slug: string): string {
  return `${PLAN_STATE_DIR}/${slug}.feedback.json`
}

export function savedFeedbackPath(appRoot: string, slug: string): string {
  return join(appRoot, savedFeedbackFile(slug))
}

/** `saved` when the file reads, `unreadable` with the reason when it exists and does not; neither when there is none. */
export async function readSavedPlanFeedback(appRoot: string, slug: string): Promise<{ saved?: SavedPlanFeedback; unreadable?: string }> {
  const { value, unreadable } = await readBesideRecord(savedFeedbackPath(appRoot, slug), SavedFeedbackSchema, 'saved review')
  return unreadable ? { unreadable } : value ? { saved: value } : {}
}

export async function writeSavedPlanFeedback(appRoot: string, slug: string, planDigest: string, feedback: PlanFeedback): Promise<SavedPlanFeedback> {
  const saved: SavedPlanFeedback = { feedbackVersion: 1, planDigest, savedAt: new Date().toISOString(), feedback }
  await ensurePlanStateIgnored(appRoot)
  await writeFileAtomic(savedFeedbackPath(appRoot, slug), `${JSON.stringify(saved, null, 2)}\n`)
  return saved
}

/** What the plan list says about saved feedback without carrying the comments themselves. */
export function summarizeSavedFeedback(saved: SavedPlanFeedback, slug: string, planDigest: string) {
  const { elements, answers } = saved.feedback
  return {
    file: savedFeedbackFile(slug),
    savedAt: saved.savedAt,
    /** False once the plan changed after the review: `plan:revise` will not apply it. */
    current: saved.planDigest === planDigest,
    approved: elements.filter((element) => element.verdict === 'approve').length,
    changes: elements.filter((element) => element.verdict === 'changes').length,
    comments: elements.filter((element) => element.comment.trim() !== '').length,
    answers: answers.length,
  }
}

export type SavedFeedbackSummary = ReturnType<typeof summarizeSavedFeedback>
