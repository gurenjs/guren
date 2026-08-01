/**
 * Zod v3/v4 compatibility primitives shared by the CLI's TypeScript-type
 * renderer (`@guren/cli/schema-type-extractor`) and the OpenAPI schema-object
 * renderer (`@guren/openapi`).
 *
 * Internal by the rules in `contributing/api-stability.md`: reachable only
 * through a deep import under `internal/`, never re-exported from
 * `@guren/core`'s index.
 *
 * Zod v3 tags every node with `_def.typeName` (`"ZodString"`); v4 uses
 * `_def.type` (`"string"`) or a top-level `.type`. Everything here exists to
 * read a node's shape without caring which major produced it. What does NOT
 * belong here: the two type switches that turn a node into an output
 * (a TypeScript type string vs. an OpenAPI schema object) — those produce
 * genuinely different results and stay in their own packages. `isOptional`
 * also stays out: the CLI reads only the rendered side of a `.pipe()` (input
 * or output, matching what `zodToType` returns for that side), while the
 * OpenAPI walker requires *both* sides to allow omission, since a pipeline
 * runs both stages against a real request. That is a real behavioral
 * difference, not incidental drift — merging it would change one of the two
 * outputs.
 */

export interface ZodSchemaLike {
  _def?: Record<string, unknown>
  type?: string
  shape?: Record<string, ZodSchemaLike>
}

/**
 * Which side of a schema is being read.
 *
 * - `output` — the parsed value, i.e. what a controller receives after
 *   validation, or what a response body looks like.
 * - `input` — the value a client has to send over the wire. Coercing and
 *   piped schemas can differ here from their output side.
 */
export type SchemaIo = 'input' | 'output'

/** v3: `_def.typeName` (`"ZodString"`). v4: `_def.type` (`"string"`) or `.type`. */
export function getTypeName(schema: ZodSchemaLike): string | undefined {
  return (schema._def?.typeName as string | undefined)
    ?? (schema._def?.type as string | undefined)
    ?? schema.type
}

/** Normalize v3's `"ZodString"` and v4's `"string"` to one lowercase name. */
export function normalizeTypeName(typeName: string | undefined): string {
  if (!typeName) return 'unknown'
  return typeName.startsWith('Zod') ? typeName.slice(3).toLowerCase() : typeName.toLowerCase()
}

/** `getTypeName` + `normalizeTypeName` combined, the pair almost every call site wants. */
export function typeOf(schema: ZodSchemaLike): string {
  return normalizeTypeName(getTypeName(schema))
}

/**
 * The first of `keys` that actually holds a nested schema object.
 *
 * `_def.type` is the one key whose meaning differs between the majors: v3
 * stores a schema there (an array's element, a `.brand()`'s inner type), v4
 * the type *name* instead. So a key only counts once it is known to be an
 * object — reading it by precedence alone is what let a v4 array document
 * its element as `{}` (or a TypeScript type collapse to `unknown[]`), the
 * same bug fixed independently in both callers before this module existed.
 */
export function schemaAt(def: Record<string, unknown>, ...keys: string[]): ZodSchemaLike | undefined {
  for (const key of keys) {
    const candidate = def[key]
    if (candidate && typeof candidate === 'object') {
      return candidate as ZodSchemaLike
    }
  }
  return undefined
}

/** The schema wrapped by a transparent single-child wrapper (`.readonly()`, `.brand()`, `.lazy()`, v3's `.transform()`/`.refine()`, etc). */
export function innerSchema(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'innerType', 'schema', 'type')
}

/**
 * An array's element schema. v4 holds it in `_def.element` and puts the string
 * `'array'` in `_def.type`; v3 has no `element` and holds the schema in
 * `_def.type`. This is the read that broke twice, once per package, and it is
 * `schemaAt`'s object check rather than the key order that fixes it — the
 * order here is the redundant second guard, not the load-bearing one.
 */
export function arrayElement(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'element', 'type')
}

/**
 * Whether this node is a `.transform()`'s output half — a wrapped function
 * with no type to read, as opposed to a schema that genuinely parses to
 * `unknown`.
 */
export function isTransform(schema: ZodSchemaLike): boolean {
  return typeOf(schema) === 'transform'
}

/**
 * Which side of a `.pipe()`/`.pipeline()` to read for a given `io` direction.
 *
 * v3 names this node `ZodPipeline`; v4 uses one `pipe` for both `.pipe()` and
 * `.transform()`. `_def.in` is what a caller sends, `_def.out` what a
 * controller receives — except for a transform, whose out side is the
 * transform function itself, leaving the in side as the best available
 * answer.
 */
export function pipeSide(def: Record<string, unknown>, io: SchemaIo): ZodSchemaLike | undefined {
  const to = schemaAt(def, 'out')
  if (io === 'output' && to && !isTransform(to)) return to
  return schemaAt(def, 'in')
}

/** v3: `_def.shape()` is a function. v4: `_def.shape` (or the schema's own `.shape`) is a plain object. */
export function objectShape(schema: ZodSchemaLike): Record<string, ZodSchemaLike> | undefined {
  const def = schema._def ?? {}
  if (typeof def.shape === 'function') {
    return (def.shape as () => Record<string, ZodSchemaLike>)()
  }
  return (def.shape ?? schema.shape) as Record<string, ZodSchemaLike> | undefined
}

/** v3: `_def.values` is an array of raw values. v4 enums: `_def.entries` is a `{ key: value }` object instead. */
export function enumValues(def: Record<string, unknown>): string[] {
  const values = def.values as string[] | undefined
  if (values) return values
  const entries = def.entries as Record<string, string> | undefined
  return entries ? Object.values(entries) : []
}

/** v3: `_def.value` holds a literal's single value. v4: `_def.values` is an array (Zod 4 literals can hold more than one). */
export function literalValues(def: Record<string, unknown>): unknown[] {
  if ('value' in def) return [def.value]
  return Array.isArray(def.values) ? def.values : []
}
