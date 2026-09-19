/**
 * The plan's ER graph as a plain value (RFC 0030 §3). Merging it with the
 * application's current schema comes later, so nothing here reads the disk: the
 * page draws whatever `{ tables, edges }` it is handed.
 */

import type { PlanChange, PlanDraft } from './schema'

export type PlanChangeKind = PlanChange['kind']

export interface PlanDiagramColumn {
  id: string
  name: string
  type: string
  change: PlanChangeKind
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  index: boolean
  /** The model id the column points at, whether or not the plan declares that model. */
  referencesModel?: string
}

export interface PlanDiagramTable {
  /** The model id, which is also the anchor the page links to. */
  id: string
  table: string
  model: string
  change: PlanChangeKind
  columns: PlanDiagramColumn[]
}

export interface PlanDiagramEdge {
  id: string
  from: string
  to: string
  label: string
  kind: 'foreignKey' | 'relationship'
}

export interface PlanDiagram {
  tables: PlanDiagramTable[]
  edges: PlanDiagramEdge[]
}

/** Ids are one namespace, so a pair of model ids names an undirected edge on its own. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function planDiagram(plan: PlanDraft): PlanDiagram {
  const tables: PlanDiagramTable[] = plan.models.map((model) => ({
    id: model.id,
    table: model.table,
    model: model.name,
    change: model.change.kind,
    columns: model.columns.map((column) => ({
      id: column.id,
      name: column.name,
      type: column.type,
      change: column.change.kind,
      nullable: column.nullable,
      primaryKey: column.primaryKey === true,
      unique: column.unique,
      index: column.index,
      referencesModel: column.references?.model,
    })),
  }))

  const declared = new Set(tables.map((table) => table.id))
  const edges: PlanDiagramEdge[] = []
  const drawn = new Set<string>()

  for (const model of plan.models) {
    for (const column of model.columns) {
      const target = column.references?.model
      // Both endpoints must be drawn. A foreign key to a model the plan does not
      // declare stays on the column, where the page still shows it; a node for it
      // could only be labelled with an element id, the one name such a target has.
      if (!target || !declared.has(target)) continue
      edges.push({ id: `fk:${column.id}`, from: model.id, to: target, label: column.name, kind: 'foreignKey' })
      drawn.add(pairKey(model.id, target))
    }
  }

  for (const model of plan.models) {
    for (const relationship of model.relationships) {
      if (!declared.has(relationship.target)) continue
      // A `belongsTo` declared beside its own foreign key would draw that pair twice.
      if (drawn.has(pairKey(model.id, relationship.target))) continue
      drawn.add(pairKey(model.id, relationship.target))
      edges.push({
        id: `rel:${model.id}:${relationship.name}`,
        from: model.id,
        to: relationship.target,
        label: `${relationship.name} (${relationship.type})`,
        kind: 'relationship',
      })
    }
  }

  return { tables, edges }
}
