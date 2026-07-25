import { discoverModelFiles, toPosixRelative, moduleNameFromRelPath } from './discovery'
import { parseModelFile, type ModelInfo, type ModelRelationship } from './model-parser'
import { SPEC_BANNER, compareStrings, type SpecArtifact } from './spec-generate'

const RELATIONSHIP_CARDINALITY: Record<ModelRelationship['type'], [string, string]> = {
  belongsTo: ['*', '1'],
  hasMany: ['1', '*'],
  hasOne: ['1', '1'],
  belongsToMany: ['*', '*'],
  hasManyThrough: ['1', '*'],
  morphMany: ['1', '*'],
  morphTo: ['*', '1'],
}

interface DomainModel {
  info: ModelInfo
  relPath: string
  module: string | null
}

/**
 * Domain view: model classes grouped by module with relationship edges —
 * deliberately distinct from the DB-level ER view (`er.md`). One diagram
 * answers one question.
 */
export async function generateDomainSpec(cwd: string): Promise<SpecArtifact> {
  const files = await discoverModelFiles(cwd)
  const parsed = await Promise.all(files.map((file) => parseModelFile(file)))
  const models: DomainModel[] = parsed
    .flatMap((info, index) => {
      if (!info) return []
      const relPath = toPosixRelative(cwd, files[index])
      return [{ info, relPath, module: moduleNameFromRelPath(relPath) }]
    })
    .sort((a, b) => compareStrings(a.info.className, b.info.className))

  const knownClasses = new Set(models.map((m) => m.info.className))

  const lines: string[] = [SPEC_BANNER, '', '# Domain Model', '']
  lines.push(
    'Model classes and their declared relationships, grouped by module. Attributes live in the ER view (`er.md`).',
    '',
  )

  if (models.length === 0) {
    lines.push('No models found.', '')
    return { fileName: 'domain.md', content: lines.join('\n') }
  }

  lines.push('```mermaid', 'classDiagram')

  const moduleNames = [...new Set(models.map((m) => m.module).filter((m): m is string => m !== null))].sort()
  const rootModels = models.filter((m) => m.module === null)

  const renderClass = (model: DomainModel, indent: string): void => {
    const traits = [
      model.info.usesAuth ? 'Authenticatable' : undefined,
      model.info.hasSoftDeletes ? 'SoftDeletes' : undefined,
    ].filter((t): t is string => t !== undefined)
    if (traits.length === 0) {
      lines.push(`${indent}class ${model.info.className}`)
      return
    }
    lines.push(`${indent}class ${model.info.className} {`)
    for (const trait of traits) {
      lines.push(`${indent}  <<${trait}>>`)
    }
    lines.push(`${indent}}`)
  }

  for (const model of rootModels) {
    renderClass(model, '  ')
  }
  for (const moduleName of moduleNames) {
    lines.push(`  namespace ${moduleName} {`)
    for (const model of models.filter((m) => m.module === moduleName)) {
      renderClass(model, '    ')
    }
    lines.push('  }')
  }

  for (const model of models) {
    for (const rel of [...model.info.relationships].sort((a, b) => compareStrings(a.name, b.name))) {
      if (!rel.relatedModel || !knownClasses.has(rel.relatedModel)) continue
      const [from, to] = RELATIONSHIP_CARDINALITY[rel.type]
      lines.push(
        `  ${model.info.className} "${from}" --> "${to}" ${rel.relatedModel} : ${rel.name}`,
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
