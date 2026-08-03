/**
 * The `--fields "name:type,..."` vocabulary shared by the scaffolders that
 * accept one (`make:feature`, `make:validator`, the `resource` blueprint).
 *
 * It lives here rather than in any one generator so that none of them has to
 * reach into another to parse the same string — `make:feature` composes
 * `make:validator`, so a definition owned by either would be a cycle.
 */

export const FIELD_TYPES = ['string', 'number', 'boolean', 'text', 'date', 'json'] as const

export type FieldType = (typeof FIELD_TYPES)[number]

export interface FieldDefinition {
  name: string
  type: FieldType
  nullable?: boolean
}

/**
 * What `make:feature` scaffolds when no `--fields` is given: enough of a shape
 * for the generated model, controller, and pages to agree with each other.
 *
 * `make:validator` deliberately does not share this — a standalone validator
 * has no siblings to agree with, so inventing `title`/`body` for an entity
 * that has neither is two fields the caller has to notice and delete.
 */
export const DEFAULT_FIELDS: FieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text', nullable: true },
]

export function parseFieldsString(fieldsStr: string): FieldDefinition[] {
  if (!fieldsStr.trim()) return DEFAULT_FIELDS

  return fieldsStr.split(',').map((field) => {
    const parts = field.trim().split(':')
    const name = parts[0]?.trim()
    const rawType = parts[1]?.trim() ?? 'string'
    const nullable = rawType.endsWith('?')
    const type = nullable ? rawType.slice(0, -1) : rawType

    if (!name) throw new Error(`Invalid field definition: "${field}"`)

    // The name becomes an object key, a property access and a state key in the
    // generated code, so anything that is not an identifier produces a file
    // that cannot be parsed — better to say so than to emit it.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`Invalid field name "${name}". Use a valid identifier, e.g. "publishedAt".`)
    }

    if (!FIELD_TYPES.includes(type as FieldType)) {
      throw new Error(`Invalid field type "${type}" for field "${name}". Valid: ${FIELD_TYPES.join(', ')}`)
    }

    return { name, type: type as FieldType, nullable }
  })
}
