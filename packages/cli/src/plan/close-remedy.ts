/**
 * The one rule for why an element `plan:close` refuses is held and what moves it (RFC 0030 §7),
 * which `plan:close` prints and `plan:next` lists once every step is verified. Pure: the steps
 * come from the task derivation.
 */

import type { Plan, PlanDraft } from './schema'
import { awaitsVerification, type PlanElementState, type PlanElementStatus } from './status'
import { listPlanSteps, type PlanTaskDerivation } from './tasks'
import { behaviourReach, restsOnReach } from './verification'

interface BlockerContext {
  planArgument: string
  /** The step that verifies each element. */
  owners: Map<string, string>
  /** The steps whose behaviours reach each element, which is what lifts one `restsOnReach()` holds for. */
  carriers: Map<string, string[]>
}

export interface CloseBlocker {
  id: string
  state: PlanElementState
  /** The hold's note, or for no hold or an `incomplete` one the reader's reason or last note; absent when none says. */
  holds?: string
  /** The command that moves it. */
  moves: string
}

/** Each element `plan:close` refuses, with what holds it and the command that moves it. */
export function describeCloseBlockers(
  plan: PlanDraft | Plan,
  derivation: PlanTaskDerivation,
  elements: ReadonlyArray<PlanElementStatus<PlanElementState>>,
  planArgument: string,
): CloseBlocker[] {
  const context: BlockerContext = { planArgument, owners: new Map(), carriers: new Map() }
  for (const { step } of listPlanSteps(derivation)) {
    for (const id of step.elementIds) context.owners.set(id, step.id)
    if (step.kind === 'tests' || step.acceptanceIds.length === 0) continue
    for (const id of behaviourReach(plan, step.acceptanceIds)) {
      const carriers = context.carriers.get(id)
      if (carriers) carriers.push(step.id)
      else context.carriers.set(id, [step.id])
    }
  }
  return elements.map((element) => {
    const hold = element.hold
    const said = element.notes.filter((note) => note !== hold?.note).at(-1)
    const why = hold && hold.kind !== 'incomplete' ? hold.note : (element.reason ?? said)
    return { id: element.id, state: element.state, ...(why ? { holds: why.replace(/\.$/u, '') } : {}), moves: closeRemedy(element, context) }
  })
}

/** The line pair `plan:close` refuses with and `plan:next` lists. */
export function formatCloseBlocker(blocker: CloseBlocker): string {
  return `  ${blocker.id}: ${blocker.state}${blocker.holds ? ` (${blocker.holds})` : ''}\n    ${blocker.moves}`
}

/**
 * Mirrors `applyVerification()`'s holds: a run it would not count is never suggested, so an
 * element no step's behaviour reaches, or one with nothing to fingerprint, is sent to plan:waive.
 */
function closeRemedy(element: PlanElementStatus<PlanElementState>, context: BlockerContext): string {
  const owner = context.owners.get(element.id)
  const verify = (step: string): string => `\`bunx guren plan:verify ${context.planArgument} --step ${step}\``
  const waive = `\`bunx guren plan:waive ${context.planArgument} ${element.id} --reason "<why>"\``
  const orWaive = `; or waive it: ${waive}`
  if (owner === undefined) return `No step of the plan verifies it, so no plan:verify run lifts it: waive it with ${waive}`
  if (element.state === 'blocked') return `Fix what keeps it from being read, then run ${verify(owner)}${orWaive}`
  if (element.hold?.kind === 'expired') return `Run ${verify(owner)} again, since that run no longer holds${orWaive}`
  if (!awaitsVerification(element)) {
    const target = element.state === 'planned' ? 'Implement it' : `Change the code until plan:status reports it ${element.completesAt}`
    return `${target}, then run ${verify(owner)}${orWaive}`
  }
  const unmatched = restsOnReach(element)
  const needsNoFiles = element.change === 'drop' || element.state === 'unjudged'
  const carriers = context.carriers.get(element.id) ?? []
  if (unmatched && carriers.length === 0) {
    return `No planned property of it matched beyond its existence and no step's behaviour reaches it, so no plan:verify run lifts it: waive it with ${waive}, or add a behaviour that reaches it and approve the plan again`
  }
  if (element.files.length === 0 && !needsNoFiles) return `plan:verify cannot fingerprint it, so no run lifts it: waive it with ${waive}`
  const runs = unmatched && !carriers.includes(owner) ? [carriers[0]!, owner] : [owner]
  return `Run ${runs.map(verify).join(', then ')}${orWaive}`
}
