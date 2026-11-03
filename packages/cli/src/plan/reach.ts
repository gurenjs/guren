/**
 * Which plan elements a behaviour reaches (RFC 0030 §6), following the plan's own references.
 * A leaf of `status.ts` and `verification.ts`, which both say what moves an element nothing reaches.
 */

import { listPlanReferences, PLAN_REFERENCES, type PlanReferenceField } from './references'
import { listPlanElementEntries, type Plan, type PlanDraft } from './schema'
import { listPlanSteps, planElementParents, type PlanTaskDerivation } from './tasks'

/**
 * Which references a behaviour's reach follows (RFC 0030 §6). A route runs its action, which
 * validates, authorizes and responds with what it names; a page shows its props' resources.
 * A view's form and action routes do not: posting to a route shows nothing of the page that
 * links to it. Total, so a new reference is a decision here.
 */
const REFERENCE_CARRIES_BEHAVIOUR: Record<PlanReferenceField, boolean> = {
  'acceptance.route': true,
  'acceptance.inertia': true,
  'route.action': true,
  'route.bind': true,
  'action.params': true,
  'action.query': true,
  'action.body': true,
  'action.policy': true,
  'action.view': true,
  'action.resource': true,
  'view.propResource': true,
  'resource.model': true,
  'policy.model': true,
  'view.actionRoute': false,
  'view.formValidator': false,
  'view.formSubmitsTo': false,
  'column.references': false,
  'model.relationship': false,
  'question.affects': false,
  'flow.node': false,
  'task.covers': false,
}

/**
 * The elements the behaviours `acceptanceIds` exercise: what the carrying references reach
 * from them, and the controller of every action reached. Nothing in a plan links a behaviour
 * to a job, event, listener, mail or notification, so none is ever reached.
 */
export function behaviourReach(plan: PlanDraft | Plan, acceptanceIds: Iterable<string>): Set<string> {
  const edges = new Map<string, string[]>()
  for (const reference of listPlanReferences(plan)) {
    if (!REFERENCE_CARRIES_BEHAVIOUR[reference.field]) continue
    edges.set(reference.from.id, [...(edges.get(reference.from.id) ?? []), reference.to])
  }
  const parents = planElementParents(plan)
  const reached = new Set<string>()
  const pending = [...acceptanceIds]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const next of [...(edges.get(id) ?? []), parents.get(id)]) {
      if (next === undefined || reached.has(next)) continue
      reached.add(next)
      pending.push(next)
    }
  }
  return reached
}

/**
 * The steps whose behaviours reach each element, in task order, whatever their records say: a
 * standing run of one of them is what lifts an element for which `restsOnReach()` holds.
 */
export function behaviourCarriers(plan: PlanDraft | Plan, derivation: PlanTaskDerivation): Map<string, string[]> {
  const carriers = new Map<string, string[]>()
  for (const { step } of listPlanSteps(derivation)) {
    if (step.kind === 'tests' || step.acceptanceIds.length === 0) continue
    for (const id of behaviourReach(plan, step.acceptanceIds)) carriers.set(id, [...(carriers.get(id) ?? []), step.id])
  }
  return carriers
}

/** The sections a carrying reference may name; `null` is a reference that may name any element. */
const BEHAVIOUR_TARGETS = new Set(PLAN_REFERENCES.filter((entry) => REFERENCE_CARRIES_BEHAVIOUR[entry.field]).map((entry) => entry.expected))

/**
 * The elements some behaviour could reach, were one added: every element of a section a carrying
 * reference names, and what {@link behaviourReach} walks to from them and from the plan's
 * behaviours. The rest (a column, a command, a job, event, listener, mail or notification) no
 * behaviour reaches, so only a waiver lifts one for which `restsOnReach()` holds.
 */
export function behaviourCanReach(plan: PlanDraft | Plan): Set<string> {
  const targets = listPlanElementEntries(plan)
    .filter(({ section }) => BEHAVIOUR_TARGETS.has(null) || BEHAVIOUR_TARGETS.has(section))
    .map(({ id }) => id)
  const behaviours = plan.tasks.flatMap((task) => task.acceptance.map((behaviour) => behaviour.id))
  return new Set([...targets, ...behaviourReach(plan, [...targets, ...behaviours])])
}

export interface PlanElementWithoutBehaviour {
  id: string
  section: 'columns' | 'sideEffects' | 'commands'
}

/**
 * The elements an approval accepts as complete on their step's verified run alone (RFC 0030 §4):
 * outside {@link behaviourCanReach}, and of a kind no planned property lifts. A command, an added or
 * altered side effect, and an altered column; an added or renamed column is read by its properties.
 */
export function planElementsWithoutBehaviour(plan: PlanDraft | Plan): PlanElementWithoutBehaviour[] {
  const reachable = behaviourCanReach(plan)
  return listPlanElementEntries(plan).flatMap(({ id, section, element }): PlanElementWithoutBehaviour[] => {
    if (reachable.has(id)) return []
    const change = (element.change as { kind?: string } | undefined)?.kind
    if (section === 'commands') return [{ id, section }]
    if (section === 'sideEffects' && (change === 'add' || change === 'alter')) return [{ id, section }]
    if (section === 'columns' && change === 'alter') return [{ id, section }]
    return []
  })
}

const WITHOUT_BEHAVIOUR_NOUNS: Record<PlanElementWithoutBehaviour['section'], string> = {
  commands: 'commands',
  sideEffects: 'side effects',
  columns: 'altered columns',
}

/** `<kind>: <ids>` per section with any, so a long list still reads at a glance; `plan:approve` and `plan:render` print it. */
export function groupElementsWithoutBehaviour(elements: readonly PlanElementWithoutBehaviour[]): string[] {
  return (Object.keys(WITHOUT_BEHAVIOUR_NOUNS) as Array<PlanElementWithoutBehaviour['section']>).flatMap((section) => {
    const ids = elements.filter((element) => element.section === section).map((element) => element.id)
    return ids.length > 0 ? [`${WITHOUT_BEHAVIOUR_NOUNS[section]}: ${ids.join(', ')}`] : []
  })
}
