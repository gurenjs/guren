/**
 * Extracts TypeScript type literals from Zod 4 schema objects at runtime.
 * Every `_def` read the OpenAPI walker also performs goes through
 * `@guren/core/internal/zod-compat`, so the two cannot disagree about zod's
 * layout; rendering decisions live here.
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

/** Warn once per process, not once per route×field — repetition adds nothing. */
let warnedAboutZod3 = false

function refuseZod3(): void {
  if (warnedAboutZod3) return
  warnedAboutZod3 = true
  console.warn(`[warn] A route schema was skipped: ${ZOD3_UNSUPPORTED_MESSAGE}`)
}

/**
 * Convert a Zod 4 schema object to a TypeScript type string.
 * Returns `undefined` if the schema structure is unrecognizable — including a
 * zod v3 schema, which is refused loudly rather than rendered wrong.
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
  // Re-checked on every node, not just at entry: a v3 schema can sit *inside*
  // a v4 object (nothing but the type system prevents it), and without this
  // gate it would render as a silent `unknown` instead of being refused.
  if (isZod3Schema(z)) {
    refuseZod3()
    return 'unknown'
  }

  const def = z._def ?? {}
  const t = typeOf(z)

  // `.coerce` is recorded on the schema node itself, so this has to be
  // checked before the plain type mapping below claims the parsed type.
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
        // Quoted when not a bare identifier — z.object({ 'user-id': ... })
        // would otherwise emit invalid TypeScript.
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
      // An enum with no members accepts nothing, so `never` is its type. The
      // empty-array case used to fall through to `[].join()` and emit an empty
      // string, which is not valid TypeScript in the position this lands in.
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
 * Whether a field may be omitted — the presence half of the input/output split
 * that `zodToType` handles for types.
 *
 * Exported for `route-contract-check.ts`, which asks the same question of a
 * params schema key: a key the path never supplies is a key omitted from the
 * request. Shared rather than re-derived because the approximations below
 * (`.catch()` on the input side, and reading only the rendered side of a
 * `.pipe()`) are the part a second implementation would get subtly different.
 */
export function isOptional(z: ZodSchemaLike, io: SchemaIo): boolean {
  const t = typeOf(z)
  const def = z._def ?? {}
  const look = (s: unknown): boolean => (s ? isOptional(s as ZodSchemaLike, io) : false)

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
    // Read the side being rendered, so presence matches the type `zodToType`
    // reports for this node. An approximation: a pipeline runs both stages, so
    // `z.string().optional().pipe(z.string())` is reported omissible even
    // though the second stage rejects a missing value. Deciding that properly
    // means simulating a parse, not reading a `_def`.
    case 'pipe':
      return look(pipeSide(def, io))
    default:
      return false
  }
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}

/**
 * A single literal value as a TypeScript type. `JSON.stringify` cannot render
 * `undefined` — it returns `undefined` rather than a string — so a
 * `z.literal(undefined)` would otherwise reach the output as an empty string.
 */
function literalType(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}
