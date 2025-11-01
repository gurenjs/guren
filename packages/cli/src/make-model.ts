import type { WriterOptions } from './utils'
import { camelCase, resourceName, writeFileSafe } from './utils'

const MODELS_DIR = 'app/Models'

function modelTemplate(className: string): string {
  const schemaIdentifier = camelCase(className)

  return `import { Model } from '@guren/orm'
import { ${schemaIdentifier} } from '../../db/schema' // TODO: adjust to the actual table export

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect

export class ${className} extends Model<${className}Record> {
  static override table = ${schemaIdentifier}
  static override readonly recordType = {} as ${className}Record
}
`
}

export async function makeModel(name: string, options: WriterOptions = {}): Promise<string> {
  const { className } = resourceName(name)
  const filePath = `${MODELS_DIR}/${className}.ts`
  return writeFileSafe(filePath, modelTemplate(className), options)
}
