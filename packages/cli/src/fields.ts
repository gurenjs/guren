/**
 * The `--fields "name:type,..."` vocabulary shared by the scaffolders that
 * accept one (`make:feature`, `make:validator`, the `resource` blueprint),
 * and its sibling `--attach "name:kind,..."` (`make:feature`, the `resource`
 * blueprint).
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

export const ATTACHMENT_KINDS = ['one', 'many'] as const

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]

export interface AttachmentDefinition {
  name: string
  kind: AttachmentKind
}

/**
 * `--attach "cover:one,images:many"`, mirroring `--fields`' shape: comma
 * separates collections, colon separates the name from its kind, and an
 * omitted kind defaults the way an omitted field type does (`cover` reads as
 * `cover:one` — the common case, like Rails' `has_one_attached`).
 *
 * Duplicates are rejected here, unlike in `parseFieldsString`: a repeated
 * field is a harmless duplicated form input, but a repeated collection is a
 * duplicate object key in the generated `Attachable` declaration — the second
 * silently wins and the first kind is discarded.
 *
 * The empty string means "no attachments", matching how an omitted `--attach`
 * reaches the scaffolders.
 */
export function parseAttachString(attachStr: string): AttachmentDefinition[] {
  if (!attachStr.trim()) return []

  const seen = new Set<string>()
  return attachStr.split(',').map((entry) => {
    const parts = entry.trim().split(':')
    const name = parts[0]?.trim()
    const kind = parts[1]?.trim() || 'one'

    if (!name) throw new Error(`Invalid attachment definition: "${entry}"`)

    // Same rule as field names, for the same reason: the name becomes an
    // object key in the model declaration, a variable in the generated store
    // action, and a multipart field name.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`Invalid attachment name "${name}". Use a valid identifier, e.g. "coverImage".`)
    }

    if (!ATTACHMENT_KINDS.includes(kind as AttachmentKind)) {
      throw new Error(`Invalid attachment kind "${kind}" for "${name}". Valid: ${ATTACHMENT_KINDS.join(', ')}`)
    }

    if (seen.has(name)) {
      throw new Error(`Duplicate attachment collection "${name}".`)
    }
    seen.add(name)

    return { name, kind: kind as AttachmentKind }
  })
}
