import { discoverParsedModels, type DiscoveredModel, type ModelRelationship } from './model-parser'
import { parseSchemaTables, type SchemaTable } from './schema-parser'
import { SPEC_BANNER, specFrontmatter, compareStrings, mermaidToken, type SpecArtifact } from './spec-artifact'

interface ErEdge {
  from: string
  to: string
  cardinality: string
  label: string
}

const RELATIONSHIP_CARDINALITY: Record<ModelRelationship['type'], string | undefined> = {
  belongsTo: '}o--||',
  hasMany: '||--o{',
  hasOne: '||--o|',
  belongsToMany: '}o--o{',
  hasManyThrough: '||--o{',
  morphMany: '||--o{',
  morphTo: undefined, // target is polymorphic — no single table to draw an edge to
}

/**
 * The related model's table for a relationship edge. Same-named models can
 * exist in several locations; preference order (owning model's module,
 * then app root, then code-unit order) keeps the choice deterministic
 * regardless of filesystem discovery order.
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

/**
 * ER view of the database: entities/attributes come from the parsed
 * Drizzle schema, edges come from model relationship declarations (plus
 * explicit `.references()` FKs when present) — scaffolded schemas don't
 * emit FK constraints, so the model layer is the reliable edge source.
 */
export async function generateErSpec(cwd: string): Promise<SpecArtifact> {
  const tables = (await parseSchemaTables(cwd)).sort((a, b) =>
    compareStrings(a.identifier, b.identifier),
  )

  const models = (await discoverParsedModels(cwd)).sort(
    (a, b) => compareStrings(a.info.className, b.info.className) || compareStrings(a.relPath, b.relPath),
  )
  const modelsByClass = new Map<string, DiscoveredModel[]>()
  for (const model of models) {
    const list = modelsByClass.get(model.info.className) ?? []
    list.push(model)
    modelsByClass.set(model.info.className, list)
  }

  const edges: ErEdge[] = []
  const coveredPairs = new Set<string>()

  for (const model of models) {
    const from = model.info.tableName
    if (!from) continue
    for (const rel of model.info.relationships) {
      const cardinality = RELATIONSHIP_CARDINALITY[rel.type]
      if (!cardinality || !rel.relatedModel) continue
      const to = resolveTargetTable(model, modelsByClass.get(rel.relatedModel) ?? [])
      if (!to) continue
      edges.push({ from, to, cardinality, label: rel.name })
      coveredPairs.add(`${from}->${to}`)
    }
  }

  // Explicit FKs complement the model edges (skipped when a model
  // relationship already covers the same table pair)
  for (const table of tables) {
    for (const column of table.columns) {
      const reference = column.references
      if (!reference) continue
      if (coveredPairs.has(`${table.identifier}->${reference.table}`)) continue
      edges.push({
        from: table.identifier,
        to: reference.table,
        cardinality: '}o--||',
        label: column.name,
      })
    }
  }

  const lines: string[] = [
    ...specFrontmatter('ER Diagram', 'Entities, attributes, and relationship edges derived from the schema and models.'),
    SPEC_BANNER,
    '',
    '# ER Diagram',
    '',
  ]
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
  for (const edge of edges.sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.label, b.label),
  )) {
    lines.push(
      `  ${mermaidToken(edge.from)} ${edge.cardinality} ${mermaidToken(edge.to)} : ${mermaidToken(edge.label)}`,
    )
  }
  lines.push('```', '')

  // Attribute detail per table (what the diagram can't carry: nullability)
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

function renderTableOrigin(table: SchemaTable): string {
  const parts: string[] = []
  if (table.tableName && table.tableName !== table.identifier) parts.push(`table: ${table.tableName}`)
  if (table.module) parts.push(`module: ${table.module}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}
