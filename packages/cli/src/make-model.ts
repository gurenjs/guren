import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { scaffoldFileEntry, writeScaffoldFile } from './utils'
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

export type ModelRelationshipType = 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany'

/** A relationship a model registers at module level, as `model-parser.ts` reads it back. */
export interface ModelRelationshipSource {
  name: string
  type: ModelRelationshipType
  /** The related class, lazily imported from `./<className>.js` beside the model; its record type is `<relatedClass>Record`, the name the parser reads the target by. */
  relatedClass: string
  /** The call's arguments after the related loader, as source: the pivot for `belongsToMany`, then the keys. */
  args: string[]
}

export interface ModelSourceOptions {
  className: string
  schemaIdentifier: string
  attachments?: AttachmentDefinition[]
  /** Written as `defineModel()`'s `fillable` option when non-empty. */
  fillable?: string[]
  relationships?: ModelRelationshipSource[]
  /** Further `db/schema` exports the file reads: related tables, a pivot. */
  schemaImports?: string[]
  /** Local type declarations after the model's own record types. */
  typeDeclarations?: string[]
}

const RELATION_RECORD: Record<ModelRelationshipType, { type: string; placeholder: string }> = {
  hasOne: { type: 'HasOneRecord', placeholder: 'null' },
  hasMany: { type: 'HasManyRecord', placeholder: '[]' },
  belongsTo: { type: 'BelongsToRecord', placeholder: 'null' },
  belongsToMany: { type: 'BelongsToManyRecord', placeholder: '[]' },
}

function attachableFactory(kind: AttachmentDefinition['kind']): string {
  return kind === 'one' ? 'hasOneAttached' : 'hasManyAttached'
}

/** The model source `make:model` writes, and `plan:scaffold` with the plan's fillable and relationships. */
export function buildModelSource(options: ModelSourceOptions): string {
  const { className, schemaIdentifier } = options
  const attachments = options.attachments ?? []
  const relationships = options.relationships ?? []
  const fillable = options.fillable ?? []

  // `image: 'require'` (full-decode validation, 422 on non-image) is this
  // scaffold's own default, not the framework's; the author drops it per
  // collection for opaque bytes such as PDFs or archives.
  const factories = [...new Set(attachments.map((attachment) => attachableFactory(attachment.kind)))]
  const values = attachments.length === 0 ? ['defineModel'] : ['Attachable', 'defineModel', ...factories].sort()
  const types = [...new Set(relationships.map((relationship) => RELATION_RECORD[relationship.type].type))].sort().map((type) => `type ${type}`)
  const schemaImports = [schemaIdentifier, ...[...new Set(options.schemaImports ?? [])].filter((name) => name !== schemaIdentifier).sort()]

  const defined = fillable.length === 0
    ? `defineModel(${schemaIdentifier})`
    : `defineModel(${schemaIdentifier}, {\n  fillable: [${fillable.map((name) => `'${name}'`).join(', ')}],\n})`
  const declaration = attachments
    .map((attachment) => `  ${attachment.name}: ${attachableFactory(attachment.kind)}({ image: 'require' }),`)
    .join('\n')
  const heritage = attachments.length === 0 ? defined : `Attachable(${defined}, {\n${declaration}\n})`

  const body = relationships.length === 0
    ? ''
    : [
        '  static override relationTypes: {',
        ...relationships.map((relationship) => `    ${relationship.name}: ${RELATION_RECORD[relationship.type].type}<${relationship.relatedClass}Record>`),
        '  } = {',
        ...relationships.map((relationship) => `    ${relationship.name}: ${RELATION_RECORD[relationship.type].placeholder},`),
        '  }',
        '',
      ].join('\n')
  const calls = relationships.map((relationship) => {
    const loader = `() => import('./${relationship.relatedClass}.js').then((module) => module.${relationship.relatedClass})`
    return `${className}.${relationship.type}('${relationship.name}', ${[loader, ...relationship.args].join(', ')})\n`
  })
  const declarations = (options.typeDeclarations ?? []).map((line) => `${line}\n`).join('')

  return `import { ${[...values, ...types].join(', ')} } from '@guren/core'
import { ${schemaImports.join(', ')} } from '../../db/schema.js'

export type ${className}Record = typeof ${schemaIdentifier}.$inferSelect
export type New${className}Record = typeof ${schemaIdentifier}.$inferInsert
${declarations}
export class ${className} extends ${heritage} {
${body}}
${calls.length > 0 ? `\n${calls.join('')}` : ''}`
}

export async function makeModel(name: string, options: MakeModelOptions = {}): Promise<string> {
  const { path, contents } = modelFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

export function modelFile(name: string, options: MakeModelOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: MODELS_DIR,
    template: ({ className }) =>
      buildModelSource({ className, schemaIdentifier: schemaIdentifierFor(className), attachments: options.attachments ?? [] }),
  }, options)
}
