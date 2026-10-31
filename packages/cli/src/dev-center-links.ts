import type { DocsViewerOpenPlan, PlanOverview } from './docs-viewer-plans'
import { planSlug } from './plan/state'

/** A path on the running dev server, which owns the origin; `McpServiceProvider` mounts it. */
export function devCenterPlanPath(planFile: string): string {
  return `/_guren/plans/${encodeURIComponent(planSlug(planFile))}`
}

/** One line for a plan command's text output, naming where the person reads the plan's state. */
export function devCenterPlanLine(planFile: string): string {
  return `Dev Center: ${devCenterPlanPath(planFile)} on the running dev server shows the person every step of this plan.`
}

/** What `/_guren/plans.json` returns: `guren_get_plans`'s overview, each plan with the slug its page is served under. */
export interface DevCenterPlans extends Omit<PlanOverview, 'plans'> {
  plans: Array<DocsViewerOpenPlan & { slug: string }>
}

export function devCenterPlans(overview: PlanOverview): DevCenterPlans {
  return { ...overview, plans: overview.plans.map((plan) => ({ ...plan, slug: planSlug(plan.file) })) }
}
