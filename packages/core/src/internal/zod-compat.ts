/**
 * Zod 4 schema-reading primitives shared by `@guren/cli`'s TypeScript-type
 * renderer (`src/schema-type-extractor.ts`) and the OpenAPI schema-object
 * renderer (`@guren/openapi`).
 *
 * Internal by the rules in `contributing/api-stability.md`: reachable only
 * through a deep import under `internal/`, never re-exported from
 * `@guren/core`'s index.
 *
 * Zod 4 only. The zod 3 API (whether from the old `zod@3` package or the
 * `zod/v3` subpath that zod 4 ships for migration) tags every node with
 * `_def.typeName` and overloads `_def.type` to hold a nested schema — the
 * ambiguity behind a bug this module's predecessors fixed twice. Rather than
 * carrying both dialects forever, a v3 node is detected up front
 * (`isZod3Schema`) and refused with `ZOD3_UNSUPPORTED_MESSAGE`; everything
 * below it assumes the v4 layout, where `_def.type` is always the type name.
 *
 * What does NOT belong here: the two type switches that turn a node into an
 * output (a TypeScript type string vs. an OpenAPI schema object). Their leaf
 * vocabularies have legitimately diverged — the CLI renders `void`/`any`/
 * `never`, which OpenAPI has no way to express — and that is a rendering
 * decision, not schema-reading knowledge.
 *
 * Neither walker's `isOptional` belongs here either, but for a weaker reason
 * than "they are both right": the CLI reads only the side of a `.pipe()` it
 * renders, the OpenAPI walker requires both sides to permit omission, and
 * *both* are approximations that a sufficiently odd pipeline can fool. Fixing
 * them properly means simulating a parse, which is well beyond reading a
 * `_def`. They stay with their callers until someone does that.
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

/**
 * Whether this node was authored with the zod 3 API. Only v3 sets
 * `_def.typeName` (`"ZodString"`), so its presence is the discriminator —
 * checked before any other read, because on a v3 node `_def.type` holds a
 * nested *schema* and every v4-shaped read below would misfire on it.
 */
export function isZod3Schema(schema: ZodSchemaLike): boolean {
  return typeof schema._def?.typeName === 'string'
}

/**
 * The one refusal message, stated once so the CLI's console warning and the
 * OpenAPI document's warnings array cannot drift apart.
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
 * The first of `keys` that actually holds a nested schema object. The object
 * check is load-bearing: `_def` is untyped data from someone else's package,
 * and a key holding a string or function must read as absent, not as a schema.
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

/** The schema wrapped by a single-child wrapper (`.optional()`, `.readonly()`, `.catch()`, …) — always `_def.innerType` in zod 4. */
export function innerSchema(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'innerType')
}

/** An array's element schema — `_def.element`, never `_def.type`, which holds the string `'array'`. */
export function arrayElement(def: Record<string, unknown>): ZodSchemaLike | undefined {
  return schemaAt(def, 'element')
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
 * Both halves of a `.pipe()`. Zod 4 uses one `pipe` node for both `.pipe()`
 * and `.transform()`: `_def.in` is what a caller sends, `_def.out` what a
 * controller receives — except for a transform, whose out side is the
 * transform function itself and so has no type to read. `to` is therefore
 * absent for a transform, leaving `from` as the only readable answer.
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
 * An enum's values. Zod 4 stores them as the `_def.entries` object, and
 * `z.nativeEnum` produces the same node — which means `entries` can be a real
 * TypeScript numeric enum, whose runtime object also carries the reverse
 * mappings (`{ A: 0, '0': 'A' }`). A key whose own value maps back to a number
 * is such a reverse entry and is filtered out, the same rule zod itself uses
 * to decide what parses.
 */
export function enumValues(def: Record<string, unknown>): Array<string | number> {
  const entries = def.entries as Record<string, string | number> | undefined
  if (!entries) return []
  return Object.keys(entries)
    .filter((key) => typeof entries[entries[key] as never] !== 'number')
    .map((key) => entries[key])
}

/** A literal's values — always the `_def.values` array in zod 4, which may hold more than one. */
export function literalValues(def: Record<string, unknown>): unknown[] {
  return Array.isArray(def.values) ? def.values : []
}

/**
 * Wrappers that neither add to a rendered type nor decide whether a field may
 * be omitted — whatever they wrap answers both questions. (`lazy` is here for
 * membership only: its child hides behind `_def.getter`, which no walker
 * calls, so looking through it reads as "contents unavailable" rather than
 * "unsupported type".)
 */
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'catch', 'readonly', 'lazy',
])

/**
 * Wrappers that pass their type through but *do* decide presence: each makes a
 * field omissible, or (in `nonoptional`'s case) re-requires one.
 */
export const PRESENCE_WRAPPERS: ReadonlySet<string> = new Set([
  'optional', 'default', 'prefault', 'nonoptional',
])

/**
 * Every type name that carries exactly one nested schema and no shape of its
 * own — the union of the two sets above plus the two that render specially
 * (`nullable` becomes a union with null; a pipe holds one schema per side).
 *
 * This is the vocabulary, not a policy: callers partition it however their
 * rendering needs (the CLI splits transparent from presence-deciding because
 * it walks types and presence separately; the OpenAPI walker looks through all
 * of them uniformly). What none of them may do is disagree about *membership*
 * — a name known to one walker and not the other silently changes an output,
 * which is why the list lives here rather than once per package.
 */
export const SINGLE_CHILD_WRAPPERS: ReadonlySet<string> = new Set([
  ...TRANSPARENT_WRAPPERS,
  ...PRESENCE_WRAPPERS,
  'nullable', 'pipe',
])
