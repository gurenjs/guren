import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { schemaIdentifierFor } from './inflect'
import type { AttachmentDefinition } from './fields'

const MODELS_DIR = 'app/Models'

export interface MakeModelOptions extends WriterOptions {
  /**
   * Attachment collections to declare through the `Attachable` mixin
   * (`make:feature --attach`). The caller is responsible for having verified
   * that the app wires `configureAttachments()` — the mixin's statics throw
   * at first use otherwise.
   */
  attachments?: AttachmentDefinition[]
}

function attachableFactory(kind: AttachmentDefinition['kind']): string {
  return kind === 'one' ? 'hasOneAttached' : 'hasManyAttached'
}

function modelTemplate(className: string, attachments: AttachmentDefinition[]): string {
  const schemaIdentifier = schemaIdentifierFor(className)

  if (attachments.length === 0) {
    return `import { defineModel } from '@guren/core'
import { ${schemaIdentifier} } from '../../db/schema.js'

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect
export type New${className}Record = typeof ${schemaIdentifier}.$inferInsert

export class ${className} extends defineModel(${schemaIdentifier}) {
}
`
  }

  const factories = [...new Set(attachments.map((attachment) => attachableFactory(attachment.kind)))]
  const imports = ['Attachable', 'defineModel', ...factories].sort().join(', ')
  // `image: 'require'` is the RFC 0013 default for scaffolds: uploads are
  // full-decode validated as images (422 otherwise). Drop it per collection
  // for opaque bytes (PDFs, archives) — `hasOneAttached()` with no options.
  const declaration = attachments
    .map((attachment) => `  ${attachment.name}: ${attachableFactory(attachment.kind)}({ image: 'require' }),`)
    .join('\n')

  return `import { ${imports} } from '@guren/core'
import { ${schemaIdentifier} } from '../../db/schema.js'

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect
export type New${className}Record = typeof ${schemaIdentifier}.$inferInsert

export class ${className} extends Attachable(defineModel(${schemaIdentifier}), {
${declaration}
}) {
}
`
}

export async function makeModel(name: string, options: MakeModelOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MODELS_DIR,
    template: ({ className }) => modelTemplate(className, options.attachments ?? []),
  }, options)
}
