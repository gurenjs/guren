/**
 * Zod 4 schema-reading primitives shared by everything that has to read an
 * application's schemas without parsing anything: the JSON Schema walker next
 * door (`zod-json-schema.ts`, behind `@guren/openapi`, RFC 0016's agent tools,
 * and `deriveAgentTools`), `@guren/cli`'s TypeScript-type renderer
 * (`src/schema-type-extractor.ts`), and its route contract check
 * (`src/route-contract-check.ts`).
 *
 * Internal by the rules in `contributing/api-stability.md`: reachable only
 * through a deep import under `internal/`, never re-exported from
 * `@guren/server`'s or `@guren/core`'s index. It sits in this package rather
 * than `@guren/core` because `zod-json-schema.ts` beside it has to, for the
 * build-order reason that module's header explains;
 * `@guren/core/internal/zod-compat` re-exports it so consumers outside this
 * package keep writing the core specifier.
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
 * output (a TypeScript type string vs. a JSON Schema object). Their leaf
 * vocabularies have legitimately diverged — the CLI renders `void`/`any`/
 * `never`, which JSON Schema has no way to express — and that is a rendering
 * decision, not schema-reading knowledge.
 *
 * No caller's `isOptional` belongs here either, but for a weaker reason than
 * "they are all right": the CLI's type renderer reads only the side of a
 * `.pipe()` it renders, while the JSON Schema walker and the CLI's route
 * contract check require both sides to permit omission, and *every* one of them
 * is an approximation that a sufficiently odd pipeline can fool. Fixing them
 * properly means simulating a parse, which is well beyond reading a `_def`.
 * They stay with their callers until someone does that. Applying the wrapper
 * vocabulary is not policy, though, which is why `unwrapSingleChild` does live
 * here: reaching a wrapper's child is schema-reading, while what a caller
 * *concludes* from that wrapper is the caller's to decide.
 */

export interface ZodSchemaLike {
  _def?: Record<string, unknown>
  /**
   * zod 4's internal container; `values` is its own computed set of accepted
   * literals, `def` the definition of whatever the node is (for a check entry,
   * the check itself — see `schemaChecks`).
   */
  _zod?: { values?: Set<unknown>; def?: Record<string, unknown> }
  type?: string
  shape?: Record<string, ZodSchemaLike>
}

/**
 * One entry of `_def.checks`, as zod stores it: a `check` discriminator plus
 * whatever that kind carries (`minimum`, `value`, `inclusive`, `pattern`, …).
 * Left open rather than modelled as a union — the kinds are zod's to add, and
 * a reader that does not recognise one must simply ignore it.
 */
export interface ZodCheckDef extends Record<string, unknown> {
  check: string
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
 * The schema at `def[key]`, if it actually holds one. The object check is
 * load-bearing: `_def` is untyped data from someone else's package, and a key
 * holding a string or function must read as absent, not as a schema. (The
 * v3-era version of this helper took a key *list* and returned the first
 * match; with one dialect there is no precedence left to encode.)
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
 * An enum's accepted values, read from zod's own computed set at
 * `_zod.values` rather than re-derived from `_def.entries`. The distinction
 * matters because `z.nativeEnum` produces the same node and a real TypeScript
 * numeric enum's runtime object carries reverse mappings (`{ A: 0, '0': 'A' }`)
 * — and any hand-rolled filter for those has a false positive: in
 * `{ A: 'B', B: 1 }`, the key `A` *looks* like a reverse entry (`entries['B']`
 * is a number) but zod accepts `'B'`. Reading zod's set makes what we document
 * what zod parses, by construction. The `entries` fallback (values unfiltered)
 * only runs if a future zod 4.x stops exposing the set.
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
 * The refinements attached to a node (`.min()`, `.regex()`, `.multipleOf()`, …),
 * normalized to the definition objects zod keeps at each entry's `_zod.def`.
 *
 * Reading through `_zod.def` rather than the entry itself is what makes the
 * list uniform: `_def.checks` is heterogeneous by construction. A plain
 * refinement (`z.string().min(2)`) is stored as a bare check object, while a
 * format method (`z.string().url()`) stores the *format schema* — a full node
 * with `parse`, `safeParse` and the rest — in the same array. Both carry the
 * check definition at `_zod.def`, and nothing else about them is shared.
 *
 * Entries without a string `check` are dropped rather than passed through: a
 * caller switches on that discriminator, so an entry that has none can only be
 * misread.
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
 * The node's declared format, if it has one — `'email'` for `z.email()`,
 * `'safeint'` for `z.int()`.
 *
 * This is only *half* of how zod 4 records a format, and the half a caller is
 * likeliest to forget. The top-level constructors (`z.email()`, `z.iso.datetime()`)
 * set `_def.format` and attach no check; the equivalent string methods
 * (`z.string().email()`, `z.string().datetime()`) attach a `string_format`
 * check and leave `_def.format` undefined. A reader that wants "the format of
 * this schema" has to consult both this and `schemaChecks`.
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
 * it walks types and presence separately; the JSON Schema walker looks through all
 * of them uniformly). What none of them may do is disagree about *membership*
 * — a name known to one walker and not the other silently changes an output,
 * which is why the list lives here rather than once per package.
 */
export const SINGLE_CHILD_WRAPPERS: ReadonlySet<string> = new Set([
  ...TRANSPARENT_WRAPPERS,
  ...PRESENCE_WRAPPERS,
  'nullable', 'pipe',
])

/**
 * The schema a single-child wrapper wraps, in the direction being read; absent
 * for a node that is not a wrapper, or one whose child cannot be reached
 * (`z.lazy()` hides its schema behind a getter no walker calls).
 *
 * Membership comes from the set above, for the reason stated there; a pipe
 * resolves per direction, for the reason stated on `pipeSides`.
 */
export function unwrapSingleChild(schema: ZodSchemaLike, io: SchemaIo): ZodSchemaLike | undefined {
  const def = schema._def ?? {}
  const typeName = typeOf(schema)

  if (typeName === 'pipe') {
    return pipeSide(def, io)
  }

  return SINGLE_CHILD_WRAPPERS.has(typeName) ? innerSchema(def) : undefined
}
