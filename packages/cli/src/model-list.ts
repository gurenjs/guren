import { resolve } from 'node:path'
import { consola } from 'consola'
import { discoverModelFiles } from './discovery'
import { parseModelFile, type ModelInfo } from './model-parser'

export interface ModelListOptions {
  appRoot?: string
  format?: 'table' | 'json' | 'compact'
}

/**
 * Discover and parse all models in the project.
 */
export async function listModels(options: ModelListOptions = {}): Promise<ModelInfo[]> {
  const appRoot = resolve(options.appRoot ?? process.cwd())
  const files = await discoverModelFiles(appRoot)

  const models: ModelInfo[] = []
  for (const filePath of files) {
    const info = await parseModelFile(filePath)
    if (info) {
      models.push(info)
    }
  }

  models.sort((a, b) => a.className.localeCompare(b.className))
  return models
}

/**
 * Display models in the terminal.
 */
export async function displayModels(options: ModelListOptions = {}): Promise<void> {
  const models = await listModels(options)

  if (models.length === 0) {
    consola.warn('No models found in app/Models/.')
    return
  }

  const format = options.format ?? 'table'

  if (format === 'json') {
    console.log(JSON.stringify(models, null, 2))
    return
  }

  if (format === 'compact') {
    for (const model of models) {
      const rels = model.relationships.map((r) => `${r.name}(${r.type})`).join(', ')
      const tags = [
        model.usesAuth ? 'auth' : '',
        model.hasSoftDeletes ? 'softDeletes' : '',
      ].filter(Boolean).join(', ')
      const suffix = [rels, tags].filter(Boolean).join(' | ')
      console.log(`${model.className}${model.tableName ? ` [${model.tableName}]` : ''}${suffix ? ` — ${suffix}` : ''}`)
    }
    return
  }

  printModelTable(models)
}

function printModelTable(models: ModelInfo[]): void {
  const nameWidth = Math.max(5, ...models.map((m) => m.className.length))
  const tableWidth = Math.max(5, ...models.map((m) => (m.tableName ?? '—').length))
  const relWidth = Math.max(13, ...models.map((m) => formatRelationships(m).length))

  const header = `${'Model'.padEnd(nameWidth)} | ${'Table'.padEnd(tableWidth)} | ${'Relationships'.padEnd(relWidth)} | Traits`
  console.log('\x1b[1m' + header + '\x1b[0m')
  console.log('-'.repeat(header.length))

  for (const model of models) {
    const traits = [
      model.usesAuth ? 'auth' : '',
      model.hasSoftDeletes ? 'softDeletes' : '',
    ].filter(Boolean).join(', ') || '—'

    const line = `${model.className.padEnd(nameWidth)} | ${(model.tableName ?? '—').padEnd(tableWidth)} | ${formatRelationships(model).padEnd(relWidth)} | ${traits}`
    console.log(line)
  }

  console.log('')
  console.log(`Total: ${models.length} model${models.length === 1 ? '' : 's'}`)
}

function formatRelationships(model: ModelInfo): string {
  if (model.relationships.length === 0) return '—'
  return model.relationships
    .map((r) => {
      const target = r.relatedModel ? ` → ${r.relatedModel}` : ''
      return `${r.name}(${shortRelType(r.type)}${target})`
    })
    .join(', ')
}

function shortRelType(type: string): string {
  const map: Record<string, string> = {
    belongsTo: 'bt',
    hasMany: 'hm',
    hasOne: 'ho',
    belongsToMany: 'btm',
    hasManyThrough: 'hmt',
    morphMany: 'mm',
    morphTo: 'mt',
  }
  return map[type] ?? type
}
