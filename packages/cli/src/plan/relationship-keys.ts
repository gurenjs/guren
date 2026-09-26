/**
 * Which of a plan's foreign keys a relationship's call takes (RFC 0030 §5): the one rule the
 * scaffold writes a relationship by and the task derivation judges its later work by, so the two
 * cannot disagree about whether the plan states its keys.
 */

import { camelCase } from '../utils'
import type { PlanColumn, PlanDraft, PlanModel } from './schema'

type PlanReference = NonNullable<PlanColumn['references']>
export type ReferencingColumn = PlanColumn & { references: PlanReference }

export function hasReference(column: PlanColumn): column is ReferencingColumn {
  return column.references !== undefined
}

export type PlanRelationshipKeys =
  | { type: 'belongsTo' | 'hasOne' | 'hasMany'; key: ReferencingColumn }
  | { type: 'belongsToMany'; pivot: PlanModel; own: ReferencingColumn; other: ReferencingColumn }

/**
 * A `belongsTo` from the model's column referencing the target, a `hasOne`/`hasMany` from the
 * target's referencing the model, a `belongsToMany` through the one model referencing both; a
 * string says why the plan states none. `owned` narrows a `belongsTo` to the columns a run writes.
 */
export function planRelationshipKeys(
  plan: PlanDraft,
  model: PlanModel,
  relationship: PlanModel['relationships'][number],
  target: PlanModel,
  owned?: ReadonlySet<string>,
): PlanRelationshipKeys | string {
  const referencing = (of: PlanModel, to: PlanModel): ReferencingColumn[] => of.columns.filter(hasReference).filter((column) => column.references.model === to.id)
  const pick = (candidates: ReferencingColumn[], preferred: string): ReferencingColumn | undefined =>
    candidates.length === 1 ? candidates[0] : candidates.find((column) => column.name === preferred)

  if (relationship.type === 'belongsTo') {
    const key = pick(referencing(model, target).filter((column) => owned?.has(column.name) ?? true), `${relationship.name}Id`)
    return key ? { type: relationship.type, key } : `no one column of ${model.name}${owned ? ' this run writes' : ''} references ${target.name}`
  }
  if (relationship.type === 'belongsToMany') {
    const pivots = plan.models.flatMap((pivot) => {
      const own = referencing(pivot, model)[0]
      const other = referencing(pivot, target).find((column) => column !== own)
      return own && other ? [{ pivot, own, other }] : []
    })
    const only = pivots.length === 1 ? pivots[0] : undefined
    return only ? { type: relationship.type, ...only } : `${pivots.length === 0 ? 'no' : 'more than one'} model of the plan references both ${model.name} and ${target.name}`
  }
  const key = pick(referencing(target, model), `${camelCase(model.name)}Id`)
  return key ? { type: relationship.type, key } : `no one column of ${target.name} references ${model.name}`
}
