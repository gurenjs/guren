import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { MODELS_DIR } from './discovery'
import { schemaIdentifierFor } from './inflect'

function modelTemplate(className: string): string {
  const schemaIdentifier = schemaIdentifierFor(className)

  return `import { defineModel } from '@guren/core'
import { ${schemaIdentifier} } from '../../db/schema.js'

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect
export type New${className}Record = typeof ${schemaIdentifier}.$inferInsert

export class ${className} extends defineModel(${schemaIdentifier}) {
}
`
}

export async function makeModel(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MODELS_DIR,
    template: ({ className }) => modelTemplate(className),
  }, options)
}
