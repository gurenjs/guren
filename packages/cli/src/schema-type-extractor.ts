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

interface SchemaTypeOptions {
  /**
   * Required on purpose: this renderer shipped with a silent `'output'` default
   * and a caller that wanted `'input'`, which is the bug that introduced it.
   */
  io: SchemaIo
}

/**
 * The wire types a coercing schema accepts, where they differ from the parsed
 * type. Anything absent here renders the same on both sides — `z.coerce.string()`
 * and `z.coerce.boolean()` are already JSON-native, and a bare `boolean` is what
 * a checkbox's `checked` wants.
 *
 * Deliberately narrower than the full set Zod would coerce (`z.coerce.number()`
 * also takes `boolean`, `z.coerce.boolean()` takes anything at all): these are
 * the request types generated code has to *satisfy*, so narrow is both safe and
 * usable — a caller can always widen the schema if it really means "anything".
 */
const COERCED_INPUT_TYPES: Record<string, string> = {
  number: 'number | string',
  bigint: 'string',
  date: 'string',
}

function getTypeName(z: ZodAnyLike): string | undefined {
  // v3: _def.typeName = "ZodString" etc.
  // v4: _def.type = "string" etc. or top-level .type
  return (z._def?.typeName as string) ?? (z._def?.type as string) ?? z.type
}

/** Normalize v3's `"ZodString"` and v4's `"string"` to one lowercase name. */
function normalizeTypeName(typeName: string): string {
  return typeName.startsWith('Zod') ? typeName.slice(3).toLowerCase() : typeName.toLowerCase()
}

/**
 * Whether this node is a `.transform()`'s output half — a wrapped function with
 * no type to read, as opposed to a schema that genuinely parses to `unknown`.
 */
function isTransform(z: ZodAnyLike): boolean {
  const tn = getTypeName(z)
  return tn ? normalizeTypeName(tn) === 'transform' : false
}

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
  const tn = getTypeName(z)!
  const def = z._def ?? {}

  const t = normalizeTypeName(tn)

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
        const opt = isOptional(val, io) ? '?' : ''
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

    case 'pipe':
    case 'pipeline': {
      // v3 names this `ZodPipeline`; v4 uses one pipe for both `.pipe()` and
      // `.transform()`. `_def.in` is what a client sends, `_def.out` what the
      // controller receives — except for a transform, whose out side is the
      // function itself, leaving the in side as the best available answer.
      const from = def.in as ZodAnyLike | undefined
      const to = def.out as ZodAnyLike | undefined
      if (io === 'output' && to && !isTransform(to)) return zodToType(to, io)
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

/**
 * Whether a field may be omitted — the presence half of the input/output split
 * that `zodToType` handles for types.
 */
function isOptional(z: ZodAnyLike, io: SchemaIo): boolean {
  const tn = getTypeName(z)
  if (!tn) return false
  const t = normalizeTypeName(tn)
  if (t === 'optional') return true
  const def = z._def ?? {}
  const i = inner(def)
  // `.default()` fills a missing value in, so the field may be left out of a
  // request but is always there once parsed.
  if (t === 'default') return io === 'input'
  // `.catch()` swallows any failure, so nothing is ever required of a caller;
  // on the way out it is only absent if what it wraps could be.
  if (t === 'catch') return io === 'input' || (i ? isOptional(i, io) : false)
  if (t === 'pipe' || t === 'pipeline') {
    const side = (io === 'input' ? def.in : def.out) as ZodAnyLike | undefined
    return side ? isOptional(side, io) : false
  }
  if ((t === 'effects' || t === 'nullable') && i) return isOptional(i, io)
  return false
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}
