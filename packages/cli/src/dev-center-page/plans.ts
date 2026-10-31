import type { DocsViewerOpenPlan, DocsViewerStepState } from '../docs-viewer-plans'

export type DevCenterPlan = DocsViewerOpenPlan

/** `person`: nothing moves until someone reads the plan and decides. `agent`: the loop can continue on its own. */
export interface PlanAttention {
  who: 'person' | 'agent'
  title: string
  detail: string
}

/** The docs viewer's step colours (`.state-*` in docs-viewer-page/index.html), so a step reads alike in both. */
export const STEP_TONE: Record<DocsViewerStepState, 'ok' | 'warn' | 'danger' | 'muted'> = {
  verified: 'ok',
  drifted: 'warn',
  incomplete: 'warn',
  blocked: 'warn',
  'waiver-withdrawn': 'warn',
  failed: 'danger',
  outdated: 'muted',
  'not-run': 'muted',
}

/** Read from the overview alone: a held step needs the application read, which only `plan:next` does. */
export function planAttention(plan: DevCenterPlan): PlanAttention {
  if (plan.standing === 'unreadable' || plan.standing === 'baseline-removed') {
    return { who: 'person', title: 'Cannot be judged', detail: plan.reason ?? 'The plan or its approvals would not read.' }
  }
  if (plan.standing === 'draft') {
    return { who: 'person', title: 'Review and approve', detail: 'A draft. Read the rendered plan, answer its open questions, and approve it with plan:approve.' }
  }
  if (plan.standing === 'unapproved') {
    return { who: 'person', title: 'Approve the edited plan', detail: 'Edited after it was approved, so plan:next refuses it until it is approved again.' }
  }
  if (plan.unreadable?.length) {
    return { who: 'person', title: 'Records would not read', detail: 'The step outcomes and waivers below may be incomplete until the files named under Records read again.' }
  }
  const stalled = plan.steps.find((step) => step.stall)
  if (stalled?.stall) {
    return { who: 'person', title: `Stalled on ${stalled.id}`, detail: `${stalled.stall.reason} Fix the environment, revise the plan, or waive the element with plan:waive.` }
  }
  // plan:next hands out nothing for a plan that derives no steps, and the overview's next command is plan:close.
  if (plan.steps.length === 0) {
    return { who: 'person', title: 'Nothing to implement', detail: 'The plan derives no steps. Close it with plan:close, or revise it.' }
  }
  const unverified = plan.steps.find((step) => step.state !== 'verified')
  if (!unverified) {
    return { who: 'person', title: 'Ready to close', detail: 'Every step is verified. Read the work, then close the plan with plan:close.' }
  }
  const active = plan.steps.find((step) => step.active)
  return { who: 'agent', title: 'In progress', detail: active ? `Marked by plan:next: ${active.id}.` : `Next unverified step: ${unverified.id}.` }
}

export function verifiedCount(plan: DevCenterPlan): number {
  return plan.steps.filter((step) => step.state === 'verified').length
}

/** Each plan with its attention, the ones waiting on a person first, each group in the overview's order. */
export function sortPlans(plans: DevCenterPlan[]): Array<{ plan: DevCenterPlan; attention: PlanAttention }> {
  const judged = plans.map((plan) => ({ plan, attention: planAttention(plan) }))
  return [...judged.filter(({ attention }) => attention.who === 'person'), ...judged.filter(({ attention }) => attention.who === 'agent')]
}

/** Steps in task order, grouped under the task each belongs to. */
export function stepsByTask(plan: DevCenterPlan): Array<{ task: string; steps: DevCenterPlan['steps'] }> {
  const groups: Array<{ task: string; steps: DevCenterPlan['steps'] }> = []
  for (const step of plan.steps) {
    const last = groups.at(-1)
    if (last?.task === step.task) last.steps.push(step)
    else groups.push({ task: step.task, steps: [step] })
  }
  return groups
}
