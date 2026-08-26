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

  // This scaffold's own default, not the framework's: every collection gets
  // `image: 'require'` (full-decode validation, 422 on non-image) because
  // safe-by-default matches the rest of the CLI's posture, and the option
  // sits in the generated file for the author to delete. Drop it per
  // collection for opaque bytes (PDFs, archives) — `hasOneAttached()` with
  // no options.
  const factories = [...new Set(attachments.map((attachment) => attachableFactory(attachment.kind)))]
  const imports = attachments.length === 0
    ? 'defineModel'
    : ['Attachable', 'defineModel', ...factories].sort().join(', ')
  const declaration = attachments
    .map((attachment) => `  ${attachment.name}: ${attachableFactory(attachment.kind)}({ image: 'require' }),`)
    .join('\n')
  const heritage = attachments.length === 0
    ? `defineModel(${schemaIdentifier})`
    : `Attachable(defineModel(${schemaIdentifier}), {\n${declaration}\n})`

  return `import { ${imports} } from '@guren/core'
import { ${schemaIdentifier} } from '../../db/schema.js'

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect
export type New${className}Record = typeof ${schemaIdentifier}.$inferInsert

export class ${className} extends ${heritage} {
}
`
}

export async function makeModel(name: string, options: MakeModelOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MODELS_DIR,
    template: ({ className }) => modelTemplate(className, options.attachments ?? []),
  }, options)
}
