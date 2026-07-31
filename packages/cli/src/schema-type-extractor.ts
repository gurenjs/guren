/**
 * Extracts TypeScript type literals from Zod schema objects at runtime.
 * Supports both Zod v3 (`_def.typeName`) and Zod v4 (`_def.type` / `.type`).
 */

interface ZodAnyLike {
  _def?: Record<string, unknown>
  type?: string
  shape?: Record<string, ZodAnyLike>
}

/**
 * Which side of a schema to render.
 *
 * - `output` — the parsed value, i.e. what a controller receives after
 *   validation. This is what a response body looks like.
 * - `input` — the value a client has to send over the wire. Coercing schemas
 *   differ here: `z.coerce.date()` parses to a `Date`, but JSON carries it as
 *   an ISO string, so only `string` is actually sendable.
 */
export type SchemaIo = 'input' | 'output'

export interface SchemaTypeOptions {
  /** Defaults to `'output'`. */
  io?: SchemaIo
}

/**
 * The wire types a coercing schema accepts, by parsed type.
 *
 * Deliberately narrower than the full set Zod would coerce (`z.coerce.number()`
 * also takes `boolean`, `z.coerce.boolean()` takes anything at all): these are
 * the request types generated code has to *satisfy*, so a narrow, JSON-native
 * type is both safe and usable. `boolean` stays a bare boolean so it can still
 * drive a checkbox's `checked`.
 */
const COERCED_INPUT_TYPES: Record<string, string> = {
  string: 'string',
  number: 'number | string',
  boolean: 'boolean',
  bigint: 'string',
  date: 'string',
}

function getTypeName(z: ZodAnyLike): string | undefined {
  // v3: _def.typeName = "ZodString" etc.
  // v4: _def.type = "string" etc. or top-level .type
  return (z._def?.typeName as string) ?? (z._def?.type as string) ?? z.type
}

/**
 * Convert a Zod schema object to a TypeScript type string.
 * Returns `undefined` if the schema structure is unrecognizable.
 */
export function schemaToTypeString(schema: unknown, options: SchemaTypeOptions = {}): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const z = schema as ZodAnyLike
  if (!getTypeName(z)) return undefined
  return zodToType(z, options.io ?? 'output')
}

function zodToType(z: ZodAnyLike, io: SchemaIo): string {
  const tn = getTypeName(z)!
  const def = z._def ?? {}

  // Normalize: v3 uses "ZodString", v4 uses "string"
  const t = tn.startsWith('Zod') ? tn.slice(3).toLowerCase() : tn.toLowerCase()

  // `.coerce` is recorded on the schema itself in both v3 and v4, so this has
  // to be checked before the plain type mapping below claims the parsed type.
  if (io === 'input' && def.coerce === true && t in COERCED_INPUT_TYPES) {
    return COERCED_INPUT_TYPES[t]
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
      // v3: _def.value, v4: _def.values[]
      if ('value' in def) return JSON.stringify(def.value)
      const vals = def.values as unknown[]
      if (vals) return vals.map((v) => JSON.stringify(v)).join(' | ')
      return 'unknown'
    }

    case 'array': {
      // v4 holds the element in `_def.element` and puts the literal string
      // `'array'` in `_def.type` — so `element` has to be tried first, or v4
      // arrays hand that string back to `zodToType`. v3 has only `_def.type`.
      const el = (def.element ?? def.type) as ZodAnyLike | undefined
      if (el) return `${wrapComplex(zodToType(el, io))}[]`
      return 'unknown[]'
    }

    case 'object': {
      // v3: _def.shape() is a function, v4: _def.shape is an object
      const shape = typeof def.shape === 'function'
        ? (def.shape as () => Record<string, ZodAnyLike>)()
        : (def.shape ?? z.shape) as Record<string, ZodAnyLike> | undefined
      if (!shape) return 'Record<string, unknown>'
      const entries = Object.entries(shape)
      if (entries.length === 0) return '{}'
      const fields = entries.map(([key, val]) => {
        const opt = isOptional(val) ? '?' : ''
        return `${key}${opt}: ${zodToType(val, io)}`
      })
      return `{ ${fields.join('; ')} }`
    }

    case 'optional':
      return inner(def) ? zodToType(inner(def)!, io) : 'unknown'

    case 'nullable': {
      const i = inner(def)
      return i ? `${zodToType(i, io)} | null` : 'unknown | null'
    }

    case 'default':
    case 'catch':
    case 'readonly':
    case 'branded':
    case 'lazy':
      return inner(def) ? zodToType(inner(def)!, io) : 'unknown'

    case 'effects':
      // v3: .transform()/.refine() wraps in ZodEffects
      return inner(def) ? zodToType(inner(def)!, io) : 'unknown'

    case 'pipe': {
      // v4 models both `.transform()` and `.pipe()` as a pipe: `_def.in` is
      // what a client sends, `_def.out` what the controller receives.
      const from = def.in as ZodAnyLike | undefined
      const to = def.out as ZodAnyLike | undefined
      if (io === 'input') return from ? zodToType(from, io) : 'unknown'
      // A `.transform()`'s out side is an opaque function with no recoverable
      // type, so fall back to the in side rather than degrade to `unknown`.
      const parsed = to ? zodToType(to, io) : 'unknown'
      if (parsed !== 'unknown') return parsed
      return from ? zodToType(from, io) : 'unknown'
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
      // v3: _def.values[], v4: _def.entries {}
      const vals = def.values as string[] | undefined
      if (vals) return vals.map((v) => JSON.stringify(v)).join(' | ')
      const entries = def.entries as Record<string, string> | undefined
      if (entries) return Object.values(entries).map((v) => JSON.stringify(v)).join(' | ')
      return 'string'
    }

    case 'nativeenum':
      return 'string | number'

    case 'tuple':
      return 'unknown[]'

    case 'promise': {
      const i = inner(def) ?? (def.type as ZodAnyLike | undefined)
      return i ? `Promise<${zodToType(i, io)}>` : 'Promise<unknown>'
    }

    default:
      return 'unknown'
  }
}

function inner(def: Record<string, unknown>): ZodAnyLike | undefined {
  // v3: innerType or schema, v4: innerType
  return (def.innerType ?? def.schema) as ZodAnyLike | undefined
}

function isOptional(z: ZodAnyLike): boolean {
  const tn = getTypeName(z)
  if (!tn) return false
  const t = tn.startsWith('Zod') ? tn.slice(3).toLowerCase() : tn.toLowerCase()
  if (t === 'optional' || t === 'default') return true
  const def = z._def ?? {}
  const i = inner(def)
  if ((t === 'effects' || t === 'nullable' || t === 'pipe') && i) return isOptional(i)
  if (t === 'pipe' && def.in) return isOptional(def.in as ZodAnyLike)
  return false
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}
