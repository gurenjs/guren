import type { WriterOptions } from './utils'
import { camelCase, resourceName, writeFileSafe } from './utils'

function pluralizeIdentifier(name: string): string {
  if (name.endsWith('s')) {
    return name
  }
  return `${name}s`
}

const MODELS_DIR = 'app/Models'

function modelTemplate(className: string): string {
  const schemaIdentifier = pluralizeIdentifier(camelCase(className))

  return `import { Model } from '@guren/orm'
import { ${schemaIdentifier} } from '../../db/schema.js' // TODO: adjust to the actual table export

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect

export class ${className} extends Model<${className}Record> {
  static override table = ${schemaIdentifier}
  static override readonly recordType = {} as ${className}Record
  // For complex queries, start from Drizzle: ${className}.query().where(...), or use ${schemaIdentifier} directly with db.query.${schemaIdentifier}
}
`
}

export async function makeModel(name: string, options: WriterOptions = {}): Promise<string> {
  const { className } = resourceName(name)
  const filePath = `${MODELS_DIR}/${className}.ts`
  return writeFileSafe(filePath, modelTemplate(className), options)
}
