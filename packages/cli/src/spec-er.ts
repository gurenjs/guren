import { discoverModelFiles } from './discovery'
import { parseModelFile, type ModelRelationship } from './model-parser'
import { parseSchemaTables, type SchemaTable } from './schema-parser'
import { SPEC_BANNER, compareStrings, type SpecArtifact } from './spec-generate'

interface ErEdge {
  /** Child/owning side table identifier (the many side for belongsTo). */
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
 * ER view of the database: entities/attributes come from the parsed
 * Drizzle schema, edges come from model relationship declarations (plus
 * explicit `.references()` FKs when present) — scaffolded schemas don't
 * emit FK constraints, so the model layer is the reliable edge source.
 */
export async function generateErSpec(cwd: string): Promise<SpecArtifact> {
  const tables = (await parseSchemaTables(cwd)).sort((a, b) =>
    compareStrings(a.identifier, b.identifier),
  )

  const modelFiles = await discoverModelFiles(cwd)
  const models = (await Promise.all(modelFiles.map((file) => parseModelFile(file)))).filter(
    (info): info is NonNullable<typeof info> => info !== null,
  )

  // Model class name → its table identifier, for resolving relationship targets
  const tableByModel = new Map<string, string>()
  for (const model of models) {
    if (model.tableName) tableByModel.set(model.className, model.tableName)
  }

  const edges = new Map<string, ErEdge>()

  for (const model of models.sort((a, b) => compareStrings(a.className, b.className))) {
    const from = model.tableName
    if (!from) continue
    for (const rel of model.relationships) {
      const cardinality = RELATIONSHIP_CARDINALITY[rel.type]
      if (!cardinality || !rel.relatedModel) continue
      const to = tableByModel.get(rel.relatedModel)
      if (!to) continue
      edges.set(`${from}|${to}|${rel.name}`, { from, to, cardinality, label: rel.name })
    }
  }

  // Explicit FKs complement the model edges (skipped when a model
  // relationship already covers the same table pair)
  for (const table of tables) {
    for (const column of table.columns) {
      const reference = column.references
      if (!reference) continue
      const pairPrefix = `${table.identifier}|${reference.table}|`
      if ([...edges.keys()].some((key) => key.startsWith(pairPrefix))) continue
      edges.set(`${pairPrefix}${column.name}`, {
        from: table.identifier,
        to: reference.table,
        cardinality: '}o--||',
        label: column.name,
      })
    }
  }

  const lines: string[] = [SPEC_BANNER, '', '# ER Diagram', '']
  lines.push(
    'Entities and attributes are derived from `db/schema.ts` (and every module schema); edges from model relationship declarations and explicit `.references()` foreign keys.',
    '',
  )

  if (tables.length === 0) {
    lines.push('No tables found.', '')
    return { fileName: 'er.md', content: lines.join('\n') }
  }

  lines.push('```mermaid', 'erDiagram')
  for (const table of tables) {
    lines.push(`  ${table.identifier} {`)
    for (const column of table.columns) {
      const marks = [column.primaryKey ? 'PK' : undefined, column.references ? 'FK' : undefined]
        .filter(Boolean)
        .join(',')
      lines.push(`    ${column.type ?? 'unknown'} ${column.name}${marks ? ` ${marks}` : ''}`)
    }
    lines.push('  }')
  }
  for (const edge of [...edges.values()].sort(
    (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.label, b.label),
  )) {
    lines.push(`  ${edge.from} ${edge.cardinality} ${edge.to} : ${edge.label}`)
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
