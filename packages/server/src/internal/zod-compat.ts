/**
 * Zod 4 schema-reading primitives shared by everything that reads an
 * application's schemas without parsing: the JSON Schema walker next door and
 * `@guren/cli`'s type renderer and route contract check. Internal per
 * `contributing/api-stability.md`; it lives here rather than in `@guren/core` for
 * the build-order reason `zod-json-schema.ts`'s header gives, re-exported by
 * `@guren/core/internal/zod-compat`. Zod 4 only: a v3 node (tags `_def.typeName`,
 * overloads `_def.type` with a nested schema) is refused up front, so `_def.type`
 * is always the type name here. Rendering decisions (node → output, `isOptional`) stay with callers.
 */

export interface ZodSchemaLike {
  _def?: Record<string, unknown>
  /**
   * zod 4's internal container: `values` is its computed set of accepted
   * literals, `def` the definition of whatever the node is.
   */
  _zod?: { values?: Set<unknown>; def?: Record<string, unknown> }
  type?: string
  shape?: Record<string, ZodSchemaLike>
}

/**
 * One entry of `_def.checks`: a `check` discriminator plus whatever that kind
 * carries. Left open rather than a union — the kinds are zod's to add, and an
 * unrecognised one must simply be ignored.
 */
export interface ZodCheckDef extends Record<string, unknown> {
  check: string
}

/**
 * Which side of a schema is being read: `output` is the parsed value a
 * controller receives, `input` what a client sends. Coercing and piped schemas
 * differ between the two.
 */
export type SchemaIo = 'input' | 'output'

/**
 * Only zod 3 sets `_def.typeName`, so its presence is the discriminator —
 * checked before any other read, because on a v3 node `_def.type` holds a
 * nested *schema* and every v4-shaped read below would misfire on it.
 */
export function isZod3Schema(schema: ZodSchemaLike): boolean {
  return typeof schema._def?.typeName === 'string'
}

/**
 * The one refusal message, so the CLI's console warning and the OpenAPI
 * document's warnings array cannot drift apart.
 */
export const ZOD3_UNSUPPORTED_MESSAGE
  = 'this schema was authored with the zod v3 API (zod@3 or the zod/v3 subpath), which Guren does not support. Rewrite it with the zod 4 API (`import { z } from \'zod\'`).'

/** The node's type name: `_def.type` (`"string"`, `"object"`, …) or the schema's own `.type`. */
export function getTypeName(schema: ZodSchemaLike): string | undefined {
  const name = schema._def?.type ?? schema.type
  return typeof name === 'string' ? name : undefined
}

/** `getTypeName` with `'unknown'` for a node that has no readable name. */
export function typeOf(schema: ZodSchemaLike): string {
  return getTypeName(schema) ?? 'unknown'
}

/**
 * The schema at `def[key]`, if it actually holds one. `_def` is untyped data
 * from someone else's package, so a key holding a string or function must read
 * as absent rather than as a schema.
 */
export function schemaAt(def: Record<string, unknown>, key: string): ZodSchemaLike | undefined {
  const candidate = def[key]
  return candidate && typeof candidate === 'object' ? (candidate as ZodSchemaLike) : undefined
}

/** The schema wrapped by a single-child wrapper (`.optional()`, `.readonly()`, `.catch()`, …) — always `_def.innerType` in zod 4. */
export function innerSchema(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'innerType')
}

/** An array's element schema — `_def.element`, never `_def.type`, which holds the string `'array'`. */
export function arrayElement(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'element')
}

/** A record's value schema — `_def.valueType`. */
export function recordValueType(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'valueType')
}

/**
 * Whether this node is a `.transform()`'s output half — a wrapped function with
 * no type to read, as opposed to a schema that parses to `unknown`.
 */
export function isTransform(schema: ZodSchemaLike): boolean {
  return typeOf(schema) === 'transform'
}

/**
 * Both halves of a `.pipe()`. Zod 4 uses one `pipe` node for `.pipe()` and
 * `.transform()` alike: `_def.in` is what a caller sends, `_def.out` what a
 * controller receives — except for a transform, whose out side is the function
 * itself, so `to` is absent and `from` is the only readable answer.
 */
export function pipeSides(def: Record<string, unknown>): {
  from: ZodSchemaLike | undefined
  to: ZodSchemaLike | undefined
} {
  const to = schemaAt(def, 'out')
  return { from: schemaAt(def, 'in'), to: to && !isTransform(to) ? to : undefined }
}

/** The one side of a `.pipe()` that describes the `io` direction being rendered. */
export function pipeSide(def: Record<string, unknown>, io: SchemaIo): ZodSchemaLike | undefined {
  const { from, to } = pipeSides(def)
  return io === 'output' && to ? to : from
}

/** An object's property map — `_def.shape`, or the schema's own `.shape`. */
export function objectShape(schema: ZodSchemaLike): Record<string, ZodSchemaLike> | undefined {
  const def = schema._def ?? {}
  return (def.shape ?? schema.shape) as Record<string, ZodSchemaLike> | undefined
}

/**
 * An enum's accepted values, from zod's computed `_zod.values` rather than
 * re-derived from `_def.entries`: `z.nativeEnum` produces the same node, and a
 * numeric enum's reverse mappings cannot be filtered without false positives
 * (in `{ A: 'B', B: 1 }` the key `A` looks like one, yet zod accepts `'B'`).
 * The `entries` fallback only runs if a future zod 4.x stops exposing the set.
 */
export function enumValues(schema: ZodSchemaLike): Array<string | number> {
  const values = schema._zod?.values
  if (values) {
    return [...values].filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    )
  }
  const entries = schema._def?.entries as Record<string, string | number> | undefined
  return entries ? Object.values(entries) : []
}

/**
 * The refinements attached to a node, normalized to the definitions zod keeps
 * at each entry's `_zod.def`. That indirection is what makes the list uniform:
 * `_def.checks` mixes bare check objects (`z.string().min(2)`) with whole
 * format schemas (`z.string().url()`), sharing only `_zod.def`. Entries without
 * a string `check` are dropped — a caller switches on that discriminator.
 */
export function schemaChecks(schema: ZodSchemaLike): ZodCheckDef[] {
  const checks = schema._def?.checks
  if (!Array.isArray(checks)) {
    return []
  }

  return checks.flatMap((entry) => {
    const def = entry && typeof entry === 'object' ? (entry as ZodSchemaLike)._zod?.def : undefined
    return def && typeof def.check === 'string' ? [def as ZodCheckDef] : []
  })
}

/**
 * The node's declared format (`'email'` for `z.email()`), which is only half of
 * how zod 4 records one: top-level constructors set `_def.format` and attach no
 * check, while the string methods (`z.string().email()`) attach a
 * `string_format` check and leave `_def.format` undefined. A reader wanting
 * "the format of this schema" must consult this *and* `schemaChecks`.
 */
export function schemaFormat(schema: ZodSchemaLike): string | undefined {
  const format = schema._def?.format
  return typeof format === 'string' ? format : undefined
}

/** A literal's values — always the `_def.values` array in zod 4, which may hold more than one. */
export function literalValues(def: Record<string, unknown>): unknown[] {
  return Array.isArray(def.values) ? def.values : []
}

/**
 * Wrappers that neither add to a rendered type nor decide omissibility.
 * (`lazy` is here for membership only: its child hides behind `_def.getter`,
 * which no walker calls, so it reads as "contents unavailable".)
 */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'catch', 'readonly', 'lazy',
])

/**
 * Wrappers passing their type through but deciding presence: each makes a field
 * omissible, or (`nonoptional`) re-requires one.
 */
export const PRESENCE_WRAPPERS: ReadonlySet<string> = new Set([
  'optional', 'default', 'prefault', 'nonoptional',
])

/**
 * Every type name carrying exactly one nested schema and no shape of its own —
 * the two sets above plus the two that render specially (`nullable` becomes a
 * union with null; a pipe holds one schema per side). Vocabulary, not policy:
 * callers partition it as their rendering needs, but a name known to one walker
 * and not another silently changes an output, so membership lives here.
 */
export const SINGLE_CHILD_WRAPPERS: ReadonlySet<string> = new Set([
  ...TRANSPARENT_WRAPPERS,
  ...PRESENCE_WRAPPERS,
  'nullable', 'pipe',
])

/**
 * The schema a single-child wrapper wraps, in the direction being read; absent
 * for a non-wrapper, or one whose child cannot be reached (`z.lazy()` hides its
 * schema behind a getter no walker calls).
 */
export function unwrapSingleChild(schema: ZodSchemaLike, io: SchemaIo): ZodSchemaLike | undefined {
  const def = schema._def ?? {}
  const typeName = typeOf(schema)

  if (typeName === 'pipe') {
    return pipeSide(def, io)
  }

  return SINGLE_CHILD_WRAPPERS.has(typeName) ? innerSchema(def) : undefined
}
