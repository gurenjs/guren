import { discoverParsedModels, type DiscoveredModel, type ModelRelationship } from './model-parser'
import { SPEC_BANNER, specFrontmatter, compareStrings, mermaidToken, type SpecArtifact } from './spec-artifact'

const RELATIONSHIP_CARDINALITY: Record<ModelRelationship['type'], [string, string]> = {
  belongsTo: ['*', '1'],
  hasMany: ['1', '*'],
  hasOne: ['1', '1'],
  belongsToMany: ['*', '*'],
  hasManyThrough: ['1', '*'],
  morphMany: ['1', '*'],
  morphTo: ['*', '1'],
}

function classLines(model: DiscoveredModel, indent: string): string[] {
  const name = mermaidToken(model.info.className)
  const traits = [
    model.info.usesAuth ? 'Authenticatable' : undefined,
    model.info.hasSoftDeletes ? 'SoftDeletes' : undefined,
  ].filter((trait): trait is string => trait !== undefined)

  if (traits.length === 0) return [`${indent}class ${name}`]
  return [`${indent}class ${name} {`, ...traits.map((trait) => `${indent}  <<${trait}>>`), `${indent}}`]
}

/**
 * Domain view: model classes grouped by module with relationship edges —
 * deliberately distinct from the DB-level ER view (`er.md`). One diagram
 * answers one question.
 */
export async function generateDomainSpec(cwd: string): Promise<SpecArtifact> {
  const models = (await discoverParsedModels(cwd)).sort(
    (a, b) => compareStrings(a.info.className, b.info.className) || compareStrings(a.relPath, b.relPath),
  )

  const knownClasses = new Set(models.map((m) => m.info.className))

  const lines: string[] = [
    ...specFrontmatter('Domain Model', 'Model classes and their declared relationships, grouped by module.'),
    SPEC_BANNER,
    '',
    '# Domain Model',
    '',
  ]
  lines.push(
    'Model classes and their declared relationships, grouped by module. Attributes live in the ER view (`er.md`).',
    '',
  )

  if (models.length === 0) {
    lines.push('No models found.', '')
    return { fileName: 'domain.md', content: lines.join('\n') }
  }

  // One grouping, three consumers: root classes, module namespaces, edges.
  const byModule = new Map<string | null, DiscoveredModel[]>()
  for (const model of models) {
    const list = byModule.get(model.module) ?? []
    list.push(model)
    byModule.set(model.module, list)
  }
  const moduleNames = [...byModule.keys()]
    .filter((name): name is string => name !== null)
    .sort(compareStrings)

  lines.push('```mermaid', 'classDiagram')
  for (const model of byModule.get(null) ?? []) {
    lines.push(...classLines(model, '  '))
  }
  for (const moduleName of moduleNames) {
    lines.push(`  namespace ${mermaidToken(moduleName)} {`)
    for (const model of byModule.get(moduleName) ?? []) {
      lines.push(...classLines(model, '    '))
    }
    lines.push('  }')
  }

  for (const model of models) {
    for (const rel of [...model.info.relationships].sort((a, b) => compareStrings(a.name, b.name))) {
      if (!rel.relatedModel || !knownClasses.has(rel.relatedModel)) continue
      const [from, to] = RELATIONSHIP_CARDINALITY[rel.type]
      lines.push(
        `  ${mermaidToken(model.info.className)} "${from}" --> "${to}" ${mermaidToken(rel.relatedModel)} : ${rel.name}`,
      )
    }
  }
  lines.push('```', '')

  lines.push('## Models', '')
  for (const model of models) {
    const table = model.info.tableName ? ` — table: \`${model.info.tableName}\`` : ''
    lines.push(`- **${model.info.className}** (${model.relPath})${table}`)
    for (const rel of model.info.relationships) {
      const target = rel.relatedModel ? ` → ${rel.relatedModel}` : ''
      lines.push(`  - ${rel.type}: \`${rel.name}\`${target}`)
    }
  }
  lines.push('')

  return { fileName: 'domain.md', content: lines.join('\n') }
}
