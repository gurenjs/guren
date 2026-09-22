/**
 * Which derived steps depend on an element the freshness comparison did not call fresh
 * (RFC 0030 §4). Pure. A step depends on what it owns, on what its elements or behaviours
 * name (one hop through `affects`, never the closure: relationships and covers reach most of
 * a plan), and on the parent of an element it owns, a column's model or an action's controller.
 * Only `stale` holds a step. Unreadable is not evidence of change, so `unstamped` and
 * `unjudged` never hold one, and nothing unreadable releases a hold either.
 */

import type { PlanElementFreshness, PlanFreshness } from './freshness'
import type { PlanDraft } from './schema'
import { findPlanStep, listPlanSteps, planElementParents, type PlanTaskDerivation } from './tasks'

export interface PlanStepContextElement {
  id: string
  section: PlanElementFreshness['section']
  change: PlanElementFreshness['change']
  verdict: Exclude<PlanElementFreshness['verdict'], 'fresh'>
  reason?: string
  owned: boolean
  /** The step's own elements and behaviours that name it. */
  through: string[]
  /** The step's own elements it contains: columns of this model, actions of this controller. */
  within: string[]
}

export interface PlanStepContext {
  stepId: string
  taskId: string
  /** What holds the step: elements the approved plan does not describe as the application reads now. */
  stale: PlanStepContextElement[]
  /** `unstamped` and `unjudged` elements the step depends on, which hold nothing. */
  unconfirmed: PlanStepContextElement[]
}

interface JudgeStepContextOptions {
  /**
   * The marked step ({@link stepInProgress}). What it owns is its work in progress and holds
   * no step: half of it reads as stale (a model's class written before its table).
   */
  inProgress?: string
}

/** The step a session is on: the mark, stalled or not, since a stalled step is still the one being built. */
export function stepInProgress(active: { step: string } | undefined): string | undefined {
  return active?.step
}

/** Keyed by step id, for the steps that depend on a non-fresh element, in task order. */
export function judgeStepContext(plan: PlanDraft, freshness: PlanFreshness, derivation: PlanTaskDerivation, options: JudgeStepContextOptions = {}): Map<string, PlanStepContext> {
  const parents = planElementParents(plan)
  const working = new Set(options.inProgress === undefined ? [] : (findPlanStep(derivation, options.inProgress)?.step.elementIds ?? []))
  const judged = freshness.elements.filter(
    (element): element is PlanElementFreshness & { verdict: PlanStepContextElement['verdict'] } =>
      element.verdict !== 'fresh' && !(element.verdict === 'stale' && working.has(element.id)),
  )
  const contexts = new Map<string, PlanStepContext>()
  for (const { task, step } of listPlanSteps(derivation)) {
    const own = new Set([...step.elementIds, ...step.acceptanceIds])
    const context: PlanStepContext = { stepId: step.id, taskId: task.id, stale: [], unconfirmed: [] }
    for (const element of judged) {
      const owned = step.elementIds.includes(element.id)
      const through = (element.affects ?? []).filter((id) => own.has(id))
      const within = step.elementIds.filter((id) => parents.get(id) === element.id)
      if (!owned && through.length === 0 && within.length === 0) continue
      const entry: PlanStepContextElement = {
        id: element.id,
        section: element.section,
        change: element.change,
        verdict: element.verdict,
        ...(element.reason ? { reason: element.reason } : {}),
        owned,
        through,
        within,
      }
      if (element.verdict === 'stale') context.stale.push(entry)
      else context.unconfirmed.push(entry)
    }
    if (context.stale.length > 0 || context.unconfirmed.length > 0) contexts.set(step.id, context)
  }
  return contexts
}

/** How a step comes to depend on an element, as the commands print it. */
export function describeDependency(element: Pick<PlanStepContextElement, 'owned' | 'through' | 'within'>): string {
  const ways = [
    ...(element.owned ? ['owned by the step'] : []),
    ...(element.through.length > 0 ? [`named by ${element.through.join(', ')}`] : []),
    ...(element.within.length > 0 ? [`holding ${element.within.join(', ')}`] : []),
  ]
  return ways.join('; ')
}
