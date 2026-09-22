/**
 * Which derived steps depend on an element the freshness comparison did not call fresh
 * (RFC 0030 §4). Pure. A step depends on the elements it owns and on the ones its own
 * elements or behaviours name, one hop through `affects`: every model reaches most of the
 * plan through relationships and covers, so a closure would block everything on one change.
 * Only `stale` blocks. Unreadable is not evidence of change, so `unstamped` and `unjudged`
 * never block a step, and nothing unreadable lifts a block either.
 */

import type { PlanElementFreshness, PlanFreshness } from './freshness'
import { listPlanSteps, type PlanTaskDerivation } from './tasks'

export interface PlanStepContextElement {
  id: string
  section: PlanElementFreshness['section']
  change: PlanElementFreshness['change']
  verdict: Exclude<PlanElementFreshness['verdict'], 'fresh'>
  reason?: string
  /** The step owns it; otherwise `through` are the step's own elements and behaviours naming it. */
  owned: boolean
  through: string[]
}

export interface PlanStepContext {
  stepId: string
  taskId: string
  /** What blocks the step: elements the approved plan does not describe as the application reads now. */
  stale: PlanStepContextElement[]
  /** `unstamped` and `unjudged` elements the step depends on, which block nothing. */
  unjudged: PlanStepContextElement[]
}

export interface JudgeStepContextOptions {
  /**
   * The step a session is on. What it owns is its work in progress and blocks no step: half
   * of it reads as stale (a model's class written before its table).
   */
  inProgress?: string
}

/** One entry per step that depends on a non-fresh element, in task order. */
export function judgeStepContext(freshness: PlanFreshness, derivation: PlanTaskDerivation, options: JudgeStepContextOptions = {}): PlanStepContext[] {
  const contexts: PlanStepContext[] = []
  const steps = listPlanSteps(derivation)
  const working = new Set(steps.find(({ step }) => step.id === options.inProgress)?.step.elementIds)
  const judged = freshness.elements.filter(
    (element): element is PlanElementFreshness & { verdict: PlanStepContextElement['verdict'] } => element.verdict !== 'fresh' && !(element.verdict === 'stale' && working.has(element.id)),
  )
  for (const { task, step } of steps) {
    const own = new Set([...step.elementIds, ...step.acceptanceIds])
    const context: PlanStepContext = { stepId: step.id, taskId: task.id, stale: [], unjudged: [] }
    for (const element of judged) {
      const owned = step.elementIds.includes(element.id)
      const through = (element.affects ?? []).filter((id) => own.has(id))
      if (!owned && through.length === 0) continue
      const entry: PlanStepContextElement = {
        id: element.id,
        section: element.section,
        change: element.change,
        verdict: element.verdict,
        ...(element.reason ? { reason: element.reason } : {}),
        owned,
        through,
      }
      if (element.verdict === 'stale') context.stale.push(entry)
      else context.unjudged.push(entry)
    }
    if (context.stale.length > 0 || context.unjudged.length > 0) contexts.push(context)
  }
  return contexts
}
