/**
 * Extracts TypeScript type literals from Zod schema objects at runtime.
 * Supports both Zod v3 (`_def.typeName`) and Zod v4 (`_def.type` / `.type`).
 */

import {
  arrayElement,
  enumValues as sharedEnumValues,
  getTypeName,
  innerSchema,
  literalValues,
  objectShape,
  pipeSide,
  type SchemaIo,
  typeOf,
  type ZodSchemaLike,
} from '@guren/core/internal/zod-compat'

type ZodAnyLike = ZodSchemaLike

export type { SchemaIo }

interface SchemaTypeOptions {
  /**
   * Required on purpose: this renderer shipped with a silent `'output'` default
   * and a caller that wanted `'input'`, which is the bug that introduced it.
   */
  io: SchemaIo
}

/**
 * The wire types a coercing schema accepts, where they differ from the parsed
 * type; absent means the two sides are identical. Deliberately narrower than
 * what Zod would really coerce (`z.coerce.boolean()` takes anything at all) —
 * a generated type is one callers must *satisfy*, so it stays JSON-native and
 * usable, and `boolean` stays bare so it can still drive a checkbox.
 */
const COERCED_INPUT_TYPES: Record<string, string> = {
  number: 'number | string',
  bigint: 'string',
  date: 'string',
}

/**
 * Wrappers that neither add to a type nor decide presence — whatever they wrap
 * answers both questions. `zodToType` and `isOptional` walk separately, so this
 * is the one list keeping them from disagreeing about what to look through.
 */
const TRANSPARENT_WRAPPERS = new Set(['catch', 'readonly', 'branded', 'lazy', 'effects'])

/**
 * Convert a Zod schema object to a TypeScript type string.
 * Returns `undefined` if the schema structure is unrecognizable.
 */
export function schemaToTypeString(schema: unknown, options: SchemaTypeOptions): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const z = schema as ZodAnyLike
  if (!getTypeName(z)) return undefined
  return zodToType(z, options.io)
}

function zodToType(z: ZodAnyLike, io: SchemaIo): string {
  const def = z._def ?? {}
  const t = typeOf(z)

  // `.coerce` is recorded on the schema itself in both v3 and v4, so this has
  // to be checked before the plain type mapping below claims the parsed type.
  if (io === 'input' && def.coerce === true && t in COERCED_INPUT_TYPES) {
    return COERCED_INPUT_TYPES[t]
  }

  if (TRANSPARENT_WRAPPERS.has(t)) {
    const wrapped = innerSchema(def)
    return wrapped ? zodToType(wrapped, io) : 'unknown'
  }

  switch (t) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'bigint': return 'bigint'
    case 'date': return 'Date'
    case 'undefined': return 'undefined'
    case 'null': return 'null'
    case 'void': return 'void'
    case 'any': return 'any'
    case 'unknown': return 'unknown'
    case 'never': return 'never'

    case 'literal': {
      const vals = literalValues(def)
      if (vals.length > 0) return vals.map((v) => JSON.stringify(v)).join(' | ')
      return 'unknown'
    }

    case 'array': {
      const el = arrayElement(def)
      if (el) return `${wrapComplex(zodToType(el, io))}[]`
      return 'unknown[]'
    }

    case 'object': {
      const shape = objectShape(z)
      if (!shape) return 'Record<string, unknown>'
      const entries = Object.entries(shape)
      if (entries.length === 0) return '{}'
      const fields = entries.map(([key, val]) => {
        const opt = isOptional(val, io) ? '?' : ''
        return `${key}${opt}: ${zodToType(val, io)}`
      })
      return `{ ${fields.join('; ')} }`
    }

    case 'nullable': {
      const i = innerSchema(def)
      return i ? `${zodToType(i, io)} | null` : 'unknown | null'
    }

    // Presence-deciding wrappers (see `isOptional`) that pass the type through.
    // `effects` is v3's `.transform()`/`.refine()`; a transform's output has no
    // readable type, so the wrapped input type is the best available answer.
    case 'optional':
    case 'default':
    case 'prefault':
    case 'nonoptional': {
      const wrapped = innerSchema(def)
      return wrapped ? zodToType(wrapped, io) : 'unknown'
    }

    case 'pipe':
    case 'pipeline': {
      const side = pipeSide(def, io)
      return side ? zodToType(side, io) : 'unknown'
    }

    case 'transform':
      return 'unknown'

    case 'union':
    case 'discriminatedunion': {
      const opts = def.options as ZodAnyLike[] | undefined
      if (opts) return opts.map((o) => zodToType(o, io)).join(' | ')
      return 'unknown'
    }

    case 'intersection': {
      const l = def.left as ZodAnyLike | undefined
      const r = def.right as ZodAnyLike | undefined
      return `${l ? zodToType(l, io) : 'unknown'} & ${r ? zodToType(r, io) : 'unknown'}`
    }

    case 'record': {
      const vt = (def.valueType ?? def.type) as ZodAnyLike | undefined
      return vt ? `Record<string, ${zodToType(vt, io)}>` : 'Record<string, unknown>'
    }

    case 'enum': {
      const vals = sharedEnumValues(def)
      return vals.length > 0 ? vals.map((v) => JSON.stringify(v)).join(' | ') : 'string'
    }

    case 'nativeenum':
      return 'string | number'

    case 'tuple':
      return 'unknown[]'

    case 'promise': {
      const i = innerSchema(def)
      return i ? `Promise<${zodToType(i, io)}>` : 'Promise<unknown>'
    }

    default:
      return 'unknown'
  }
}

/**
 * Whether a field may be omitted — the presence half of the input/output split
 * that `zodToType` handles for types.
 */
function isOptional(z: ZodAnyLike, io: SchemaIo): boolean {
  const t = typeOf(z)
  const def = z._def ?? {}
  const look = (s: unknown): boolean => (s ? isOptional(s as ZodAnyLike, io) : false)

  if (TRANSPARENT_WRAPPERS.has(t)) {
    // `.catch()` swallows any failure, so an omitted key is never rejected;
    // on the way out it is absent only if what it wraps could be.
    if (t === 'catch' && io === 'input') return true
    return look(innerSchema(def))
  }

  switch (t) {
    case 'optional':
      return true
    // Both fill a missing value in: the field may be left out of a request but
    // is always there once parsed.
    case 'default':
    case 'prefault':
      return io === 'input'
    case 'nonoptional':
      return false
    case 'nullable':
      return look(innerSchema(def))
    // Read the side being rendered — matching what `zodToType` reports for
    // this node — rather than requiring both sides of the pipeline to agree.
    case 'pipe':
    case 'pipeline':
      return look(pipeSide(def, io))
    default:
      return false
  }
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}
