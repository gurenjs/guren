/**
 * Extracts TypeScript type literals from Zod 4 schema objects at runtime. Every `_def`
 * read goes through `@guren/core/internal/zod-compat`, so this and the JSON Schema walker
 * cannot disagree about zod's layout; rendering decisions live here.
 */

import {
  arrayElement,
  enumValues,
  getTypeName,
  innerSchema,
  isZod3Schema,
  literalValues,
  objectShape,
  pipeSide,
  recordValueType,
  type SchemaIo,
  TRANSPARENT_WRAPPERS,
  typeOf,
  unwrapSingleChild,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/core/internal/zod-compat'
import { quoteObjectKey } from './utils'

interface SchemaTypeOptions {
  /**
   * Required on purpose: this renderer shipped with a silent `'output'` default
   * and a caller that wanted `'input'`, which is the bug that introduced it.
   */
  io: SchemaIo
}

/**
 * The wire types a coercing schema accepts, where they differ from the parsed type.
 * Deliberately narrower than what Zod would really coerce: a generated type is one
 * callers must *satisfy*, so it stays JSON-native (`boolean` stays bare for a checkbox).
 */
const COERCED_INPUT_TYPES: Record<string, string> = {
  number: 'number | string',
  bigint: 'string',
  date: 'string',
}

/** Warn once per process, not once per route×field — repetition adds nothing. */
let warnedAboutZod3 = false

function refuseZod3(): void {
  if (warnedAboutZod3) return
  warnedAboutZod3 = true
  console.warn(`[warn] A route schema was skipped: ${ZOD3_UNSUPPORTED_MESSAGE}`)
}

/**
 * A Zod 4 schema as a TypeScript type string, or `undefined` when unrecognizable —
 * including a zod v3 schema, which is refused loudly rather than rendered wrong.
 */
export function schemaToTypeString(schema: unknown, options: SchemaTypeOptions): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const z = schema as ZodSchemaLike
  if (isZod3Schema(z)) {
    refuseZod3()
    return undefined
  }
  if (!getTypeName(z)) return undefined
  return zodToType(z, options.io)
}

function zodToType(z: ZodSchemaLike, io: SchemaIo): string {
  // Re-checked per node: a v3 schema can sit inside a v4 object, and would otherwise
  // render as a silent `unknown` instead of being refused.
  if (isZod3Schema(z)) {
    refuseZod3()
    return 'unknown'
  }

  const def = z._def ?? {}
  const t = typeOf(z)

  // `.coerce` sits on the node itself, so check it before the plain type mapping below
  // claims the parsed type.
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
      if (vals.length > 0) return vals.map(literalType).join(' | ')
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
        // z.object({ 'user-id': ... }) would otherwise emit invalid TypeScript.
        return `${quoteObjectKey(key)}${opt}: ${zodToType(val, io)}`
      })
      return `{ ${fields.join('; ')} }`
    }

    case 'nullable': {
      const i = innerSchema(def)
      return i ? `${zodToType(i, io)} | null` : 'unknown | null'
    }

    // Presence-deciding wrappers (see `isOptional`) that pass the type through.
    case 'optional':
    case 'default':
    case 'prefault':
    case 'nonoptional': {
      const wrapped = innerSchema(def)
      return wrapped ? zodToType(wrapped, io) : 'unknown'
    }

    case 'pipe': {
      const side = pipeSide(def, io)
      return side ? zodToType(side, io) : 'unknown'
    }

    case 'transform':
      return 'unknown'

    // `z.discriminatedUnion()` produces this same node.
    case 'union': {
      const opts = def.options as ZodSchemaLike[] | undefined
      if (opts) return opts.map((o) => zodToType(o, io)).join(' | ')
      return 'unknown'
    }

    case 'intersection': {
      const l = def.left as ZodSchemaLike | undefined
      const r = def.right as ZodSchemaLike | undefined
      return `${l ? zodToType(l, io) : 'unknown'} & ${r ? zodToType(r, io) : 'unknown'}`
    }

    case 'record': {
      const vt = recordValueType(def)
      return vt ? `Record<string, ${zodToType(vt, io)}>` : 'Record<string, unknown>'
    }

    case 'enum': {
      // An enum with no members accepts nothing; `[].join()` would emit an empty string,
      // which is not valid TypeScript in the position this lands in.
      const vals = enumValues(z)
      return vals.length > 0 ? vals.map(literalType).join(' | ') : 'never'
    }

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
 * Whether a field may be omitted — the presence half of the input/output split. What each
 * wrapper *means* for presence is this renderer's policy; only reaching the child is shared.
 */
function isOptional(z: ZodSchemaLike, io: SchemaIo): boolean {
  const t = typeOf(z)
  const child = (): boolean => {
    const wrapped = unwrapSingleChild(z, io)
    return wrapped ? isOptional(wrapped, io) : false
  }

  if (TRANSPARENT_WRAPPERS.has(t)) {
    // `.catch()` swallows any failure, so an omitted key is never rejected on input.
    if (t === 'catch' && io === 'input') return true
    return child()
  }

  switch (t) {
    case 'optional':
      return true
    // Both fill a missing value in, so the field is always there once parsed.
    case 'default':
    case 'prefault':
      return io === 'input'
    case 'nonoptional':
      return false
    case 'nullable':
      return child()
    // Reads the side being rendered, so presence matches the type reported for this node.
    // An approximation: `z.string().optional().pipe(z.string())` reports omissible even
    // though the second stage rejects a missing value.
    case 'pipe':
      return child()
    default:
      return false
  }
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}

/**
 * A single literal value as a TypeScript type. `JSON.stringify(undefined)` returns
 * `undefined` rather than a string, so `z.literal(undefined)` would emit nothing.
 */
function literalType(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}
