import { discoverParsedModels, type DiscoveredModel, type ModelRelationship } from './model-parser'
import { parseSchemaTables, type SchemaTable } from './schema-parser'
import { specHeader, compareStrings, mermaidToken, type SpecArtifact } from './spec-artifact'

/** How the two tables of an edge relate, independent of any diagram syntax. */
export type ErCardinality = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany'

/** What produced an edge; `both` is a model relationship a declared FK also backs. */
export type ErEdgeSource = 'relationship' | 'foreignKey' | 'both'

export interface ErEdge {
  /** Schema identifier of the table the edge starts at, not its SQL name. */
  from: string
  to: string
  cardinality: ErCardinality
  /** Relationship name on a model edge, FK column name on a schema edge. */
  label: string
  source: ErEdgeSource
  /**
   * The declaration behind a `relationship` or `both` edge. `hasMany`, `hasManyThrough`
   * and `morphMany` share one cardinality, so the type is not recoverable from it.
   */
  relationship?: ModelRelationship
  /** FK columns on `from` pointing at `to`; empty when no FK backs the edge. */
  foreignKeyColumns: string[]
}

/** Both arrays are ordered by {@link buildErGraph} and readonly so a consumer cannot resort them. */
export interface ErGraph {
  /** Never projected, so fields added to `SchemaColumn` reach consumers untouched. */
  tables: readonly SchemaTable[]
  edges: readonly ErEdge[]
}

const RELATIONSHIP_CARDINALITY: Record<ModelRelationship['type'], ErCardinality | undefined> = {
  belongsTo: 'manyToOne',
  hasMany: 'oneToMany',
  hasOne: 'oneToOne',
  belongsToMany: 'manyToMany',
  hasManyThrough: 'oneToMany',
  morphMany: 'oneToMany',
  morphTo: undefined, // target is polymorphic — no single table to draw an edge to
}

const MERMAID_CARDINALITY: Record<ErCardinality, string> = {
  manyToOne: '}o--||',
  oneToMany: '||--o{',
  oneToOne: '||--o|',
  manyToMany: '}o--o{',
}

/**
 * The related model's table for a relationship edge. Same-named models can exist in
 * several locations, so the preference order (owning module, app root, code-unit) keeps
 * the choice independent of filesystem discovery order.
 */
function resolveTargetTable(owner: DiscoveredModel, candidates: DiscoveredModel[]): string | undefined {
  const sorted = [...candidates].sort(
    (a, b) => compareStrings(a.module ?? '', b.module ?? '') || compareStrings(a.relPath, b.relPath),
  )
  const preferred =
    sorted.find((c) => c.module === owner.module)
    ?? sorted.find((c) => c.module === null)
    ?? sorted[0]
  return preferred?.info.tableName
}

function pairKey(from: string, to: string): string {
  return `${from}->${to}`
}

/**
 * ER graph of the database: entities and attributes from the parsed Drizzle schema, edges
 * from model relationship declarations plus explicit `.references()` FKs. Scaffolded
 * schemas emit no FK constraints, so the model layer is the reliable edge source. An FK
 * whose pair a relationship already covers annotates that relationship instead of adding
 * an edge of its own, so one link never draws twice.
 */
export function buildErGraph(
  tables: readonly SchemaTable[],
  models: readonly DiscoveredModel[],
): ErGraph {
  const sortedTables = [...tables].sort((a, b) => compareStrings(a.identifier, b.identifier))

  const sortedModels = [...models].sort(
    (a, b) => compareStrings(a.info.className, b.info.className) || compareStrings(a.relPath, b.relPath),
  )
  const modelsByClass = new Map<string, DiscoveredModel[]>()
  for (const model of sortedModels) {
    const list = modelsByClass.get(model.info.className) ?? []
    list.push(model)
    modelsByClass.set(model.info.className, list)
  }

  const edges: ErEdge[] = []
  const declaredPerPair = new Map<string, ErEdge[]>()

  for (const model of sortedModels) {
    const from = model.info.tableName
    if (!from) continue
    for (const rel of model.info.relationships) {
      const cardinality = RELATIONSHIP_CARDINALITY[rel.type]
      if (!cardinality || !rel.relatedModel) continue
      const to = resolveTargetTable(model, modelsByClass.get(rel.relatedModel) ?? [])
      if (!to) continue
      const edge: ErEdge = {
        from,
        to,
        cardinality,
        label: rel.name,
        source: 'relationship',
        relationship: rel,
        foreignKeyColumns: [],
      }
      edges.push(edge)
      const declared = declaredPerPair.get(pairKey(from, to))
      if (declared) declared.push(edge)
      else declaredPerPair.set(pairKey(from, to), [edge])
    }
  }

  for (const table of sortedTables) {
    for (const column of table.columns) {
      const reference = column.references
      if (!reference) continue
      const declared = declaredPerPair.get(pairKey(table.identifier, reference.table))
      if (declared) {
        for (const edge of declared) {
          edge.source = 'both'
          edge.foreignKeyColumns.push(column.name)
        }
        continue
      }
      edges.push({
        from: table.identifier,
        to: reference.table,
        cardinality: 'manyToOne',
        label: column.name,
        source: 'foreignKey',
        foreignKeyColumns: [column.name],
      })
    }
  }

  edges.sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.label, b.label),
  )
  return { tables: sortedTables, edges }
}

/**
 * The Mermaid ER view of a graph. Ordering comes from {@link buildErGraph}; re-sorting
 * here would let the two disagree, and `check --spec` byte-compares this output.
 */
export function renderErSpec(graph: ErGraph): SpecArtifact {
  const { tables, edges } = graph
  const lines: string[] = specHeader('ER Diagram', 'Entities, attributes, and relationship edges derived from the schema and models.')
  lines.push(
    'Entities and attributes are derived from `db/schema.ts` (and every module schema); edges from model relationship declarations and explicit `.references()` foreign keys.',
    '',
    'This is a minimal, diff-able view. For interactive exploration of the Drizzle schema, tools like drizzle-lab or Liam ERD complement it.',
    '',
  )

  if (tables.length === 0) {
    lines.push('No tables found.', '')
    return { fileName: 'er.md', content: lines.join('\n') }
  }

  lines.push('```mermaid', 'erDiagram')
  for (const table of tables) {
    lines.push(`  ${mermaidToken(table.identifier)} {`)
    for (const column of table.columns) {
      const marks = [column.primaryKey ? 'PK' : undefined, column.references ? 'FK' : undefined]
        .filter(Boolean)
        .join(',')
      lines.push(
        `    ${mermaidToken(column.type ?? 'unknown')} ${mermaidToken(column.name)}${marks ? ` ${marks}` : ''}`,
      )
    }
    lines.push('  }')
  }
  for (const edge of edges) {
    lines.push(
      `  ${mermaidToken(edge.from)} ${MERMAID_CARDINALITY[edge.cardinality]} ${mermaidToken(edge.to)} : ${mermaidToken(edge.label)}`,
    )
  }
  lines.push('```', '')

  // Attribute detail per table, for what the diagram cannot carry (nullability).
  for (const table of tables) {
    lines.push(`## ${table.identifier}${renderTableOrigin(table)}`, '')
    lines.push('| Column | Type | Constraints |')
    lines.push('|--------|------|-------------|')
    for (const column of table.columns) {
      const constraints = [
        column.primaryKey ? 'primary key' : undefined,
        column.notNull ? 'not null' : undefined,
        column.references ? `references ${column.references.table}.${column.references.column}` : undefined,
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`| ${column.name} | ${column.type ?? ''} | ${constraints} |`)
    }
    lines.push('')
  }

  return { fileName: 'er.md', content: lines.join('\n') }
}

export async function generateErSpec(cwd: string): Promise<SpecArtifact> {
  const [tables, models] = await Promise.all([parseSchemaTables(cwd), discoverParsedModels(cwd)])
  return renderErSpec(buildErGraph(tables, models))
}

function renderTableOrigin(table: SchemaTable): string {
  const parts: string[] = []
  if (table.tableName && table.tableName !== table.identifier) parts.push(`table: ${table.tableName}`)
  if (table.module) parts.push(`module: ${table.module}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}
