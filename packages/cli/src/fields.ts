/**
 * The `--fields "name:type,..."` vocabulary shared by the scaffolders that
 * accept one (`make:feature`, `make:validator`, the `resource` blueprint),
 * and its sibling `--attach "name:kind,..."` (`make:feature`, the `resource`
 * blueprint). Here rather than in any one generator because `make:feature`
 * composes `make:validator`, so a definition owned by either would be a cycle.
 */

import { isIdentifier } from './utils'

export const FIELD_TYPES = ['string', 'number', 'boolean', 'text', 'date', 'json'] as const

export type FieldType = (typeof FIELD_TYPES)[number]

export interface FieldDefinition {
  name: string
  type: FieldType
  nullable?: boolean
}

/**
 * What `make:feature` scaffolds when no `--fields` is given: enough shape for
 * the generated model, controller and pages to agree. `make:validator`
 * deliberately does not share it — a standalone validator has no siblings to
 * agree with, so these would be two fields the caller has to delete.
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

    // The name becomes an object key, a property access and a state key, so a
    // non-identifier produces a generated file that cannot be parsed.
    if (!isIdentifier(name)) {
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
 * Names `isIdentifier` accepts that still cannot be bound with `const`, which
 * is what a hasOne collection becomes in the generated store action. Field
 * names deliberately skip this list: they only ever appear as object keys and
 * property accesses, where reserved words are legal.
 */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
])

/**
 * `--attach "cover:one,images:many"`, mirroring `--fields`' shape; an omitted
 * kind defaults to `one`, and the empty string means "no attachments".
 * Duplicates are rejected here, unlike in `parseFieldsString`: a repeated
 * collection is a duplicate object key in the generated `Attachable`
 * declaration, where the second silently wins.
 */
export function parseAttachString(attachStr: string): AttachmentDefinition[] {
  if (!attachStr.trim()) return []

  const seen = new Set<string>()
  return attachStr.split(',').map((entry) => {
    const parts = entry.trim().split(':')
    const name = parts[0]?.trim()
    // The default applies only to a genuinely omitted kind: an empty or extra
    // segment (`cover:`, `cover::many`) is a typo defaulting would mask.
    const kind = parts.length > 1 ? parts[1]?.trim() : 'one'

    if (!name || parts.length > 2) throw new Error(`Invalid attachment definition: "${entry}"`)

    // Same rule as field names: the name becomes an object key, a variable in
    // the generated store action, and a multipart field name.
    if (!isIdentifier(name)) {
      throw new Error(`Invalid attachment name "${name}". Use a valid identifier, e.g. "coverImage".`)
    }

    if (RESERVED_WORDS.has(name)) {
      throw new Error(
        `Invalid attachment name "${name}": a reserved word cannot be bound as the variable the `
        + `generated store action needs. Pick another name.`,
      )
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
