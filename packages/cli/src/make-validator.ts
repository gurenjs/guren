import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { pluralize } from './inflect'
import type { FieldDefinition, FieldType } from './fields'

const VALIDATOR_DIR = 'app/Http/Validators'

export interface MakeValidatorOptions extends WriterOptions {
  /**
   * Payload columns. Omitted means an empty payload schema with a placeholder
   * comment — see `DEFAULT_FIELDS` in fields.ts for why no default applies here.
   */
  fields?: FieldDefinition[]
}

/**
 * `make:feature` calls this rather than emitting its own copy, so the schema
 * names its controller imports and the ones written here cannot drift apart.
 */
export async function makeValidator(name: string, options: MakeValidatorOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: VALIDATOR_DIR,
    suffix: 'Validator',
    // `scaffoldFile` appends the suffix; schema names are built from the bare
    // entity, so strip it back off as the sibling scaffolders do.
    template: ({ normalizedName }) => generateValidator(normalizedName.replace(/Validator$/u, ''), options.fields ?? []),
  }, options)
}

// Keyed by `FieldType` rather than `string`, so adding a field type fails to
// compile here instead of silently falling through to a string default.
function zodFieldType(field: FieldDefinition): string {
  const map: Record<FieldType, string> = {
    string: 'z.string().trim().min(1)',
    text: 'z.string().trim().min(1)',
    number: 'z.coerce.number()',
    boolean: 'z.boolean()',
    date: 'z.coerce.date()',
    // Zod 4 requires an explicit key type for records. The value is `any`
    // rather than `unknown` because Inertia's `useForm` refuses to hold an
    // `unknown` — narrow this to the object's real shape once you know it.
    json: 'z.record(z.string(), z.any())',
  }
  const schema = map[field.type]
  return field.nullable ? `${schema}.nullable().optional()` : schema
}

/**
 * `collection` is pluralized directly rather than through `collectionName()`:
 * it names a generated type, not one of the three in the schema/model/check
 * triangle, so `Status` yields `ListStatusesQuerySchema`. See inflect.ts.
 */
function generateValidator(singular: string, fields: FieldDefinition[]): string {
  const collection = pluralize(singular)
  const fieldSchemas = fields.length > 0
    ? fields.map((f) => `  ${f.name}: ${zodFieldType(f)},`).join('\n')
    : '  // Add one entry per column, e.g. title: z.string().trim().min(1),'

  return `import { z } from 'zod'

export const ${singular}IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const List${collection}QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const ${singular}PayloadSchema = z.object({
${fieldSchemas}
})

export type ${singular}Payload = z.infer<typeof ${singular}PayloadSchema>
`
}
