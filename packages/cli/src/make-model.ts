import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { MODELS_DIR } from './discovery'
import { schemaIdentifierFor } from './inflect'
import type { AttachmentDefinition } from './fields'

export interface MakeModelOptions extends WriterOptions {
  /**
   * Attachment collections to declare through the `Attachable` mixin. The
   * caller must have verified the app wires `configureAttachments()` — the
   * mixin's statics throw at first use otherwise.
   */
  attachments?: AttachmentDefinition[]
}

function attachableFactory(kind: AttachmentDefinition['kind']): string {
  return kind === 'one' ? 'hasOneAttached' : 'hasManyAttached'
}

function modelTemplate(className: string, attachments: AttachmentDefinition[]): string {
  const schemaIdentifier = schemaIdentifierFor(className)

  // `image: 'require'` (full-decode validation, 422 on non-image) is this
  // scaffold's own default, not the framework's; the author drops it per
  // collection for opaque bytes such as PDFs or archives.
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
