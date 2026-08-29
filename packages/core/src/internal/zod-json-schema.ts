/**
 * The one Zod → JSON Schema rule, shared by every surface that has to describe
 * an application's contracts to something outside the process: `@guren/openapi`
 * renders it as OpenAPI 3.1 schema objects (which *are* JSON Schema 2020-12),
 * and RFC 0016's agent tools advertise it as MCP input/output schemas.
 *
 * Internal by the rules in `contributing/api-stability.md`: reachable only
 * through a deep import under `internal/`, never re-exported from
 * `@guren/core`'s index. No stability guarantee — it exists so two derivations
 * of the same schema cannot disagree, not as a public extension point. That is
 * the whole reason it moved here from `@guren/openapi`: a second walker is how
 * an agent tool comes to advertise a schema the documented API contradicts.
 *
 * Every `_def` read goes through `zod-compat.ts`, including the check reads
 * this module added. Reaching into `_def` here would put zod-layout knowledge
 * in two places, which is exactly the split `zod-compat` exists to prevent.
 *
 * Zod 4 only, and a v3 node is *refused* rather than walked — on v3 `_def.type`
 * holds a nested schema where v4 keeps the type name, so every read below would
 * misfire and produce a confidently wrong document. The refusal is re-checked
 * at each recursion, because a v3 node can hide inside a v4 wrapper.
 *
 * What this module does not decide: what a caller does with the warnings, and
 * how the result is embedded (a `requestBody` content map, an MCP `inputSchema`).
 * Warnings are appended to a caller-owned array so a document generator can
 * surface them per request and a codegen step can fail on them.
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
  pipeSides,
  recordValueType,
  type SchemaIo,
  schemaChecks,
  schemaFormat,
  SINGLE_CHILD_WRAPPERS,
  typeOf,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodCheckDef,
  type ZodSchemaLike,
} from './zod-compat'

export type JsonSchemaPrimitiveType
  = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'

/**
 * A JSON Schema 2020-12 object, restricted to the keywords this walker emits.
 * OpenAPI 3.1's Schema Object is the same dialect, so `@guren/openapi` uses
 * this type verbatim.
 */
export interface JsonSchemaObject {
  type?: JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[]
  format?: string
  description?: string
  enum?: Array<string | number>
  const?: string | number | boolean | null
  properties?: Record<string, JsonSchemaObject>
  required?: string[]
  items?: JsonSchemaObject
  prefixItems?: JsonSchemaObject[]
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  additionalProperties?: boolean | JsonSchemaObject
  anyOf?: JsonSchemaObject[]
  oneOf?: JsonSchemaObject[]
  allOf?: JsonSchemaObject[]
}

/**
 * An object schema taken apart rather than rendered — the shape a caller needs
 * when the properties do not stay together in one schema object (OpenAPI
 * expands a `query` schema into one parameter per property, and RFC 0016 merges
 * `params` + `query` + `body` into a single tool input).
 */
export interface ObjectSchemaDetails {
  properties: Record<string, JsonSchemaObject>
  required: Set<string>
}

type ZodLike = ZodSchemaLike

/**
 * Zod's string formats mapped to the JSON Schema `format` names that mean the
 * same thing, matched against zod's own `z.toJSONSchema()` output so the two
 * cannot disagree about, say, whether `z.url()` is `"url"` or `"uri"`.
 *
 * The line is "registered by JSON Schema 2020-12", not "short". Zod carries
 * plenty of formats the spec has never registered (`cuid`, `nanoid`, `emoji`,
 * `ulid`, `jwt`, `base64`…), and emitting those verbatim advertises a
 * constraint no consumer can interpret — an agent reading `format: "cuid"`
 * learns nothing it can act on, while the `type: "string"` it already had stays
 * true. Unmapped formats are dropped, not warned about: the schema is still
 * correct, just less specific.
 *
 * `time` is the one registered format deliberately left out, and zod omits it
 * from its own output for the same reason: JSON Schema's `time` is an RFC 3339
 * `full-time`, which requires an offset, while `z.iso.time()` accepts a local
 * wall-clock time. Claiming the format would assert an offset the schema does
 * not require.
 */
const JSON_SCHEMA_STRING_FORMATS: Readonly<Record<string, string>> = {
  email: 'email',
  url: 'uri',
  uuid: 'uuid',
  datetime: 'date-time',
  date: 'date',
  duration: 'duration',
  hostname: 'hostname',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
}

/**
 * The `number_format` values that describe an integer. JSON Schema says this
 * with a *type*, not a format, so these change `type: "number"` to
 * `type: "integer"` — a `z.int()` that documents as `number` advertises a
 * contract admitting `3.14`, which the route then rejects.
 *
 * `float32` / `float64` are the other half of the same zod vocabulary and stay
 * plain numbers. The bounds each of these formats implies (zod's own emitter
 * adds `minimum: -2147483648` for `int32`, and the safe-integer range for
 * `safeint`) are deliberately not emitted: they are the representation's
 * limits rather than the application's contract, and they bury the constraints
 * an author actually wrote. `int64` / `uint64` need no entry — they sit on
 * `bigint` nodes, which this walker already renders as `integer`.
 */
const INTEGER_NUMBER_FORMATS: ReadonlySet<string> = new Set(['safeint', 'int32', 'uint32'])

/**
 * The string formats whose zod-supplied regex is worth carrying as `pattern` —
 * the ones a user *wrote as a pattern* (`.regex()`) or as a prefix/suffix/
 * substring test, which zod stores only as a compiled regex.
 *
 * The registered formats above are excluded on purpose even though zod exposes
 * a pattern for them too: their regexes run to hundreds of characters (the
 * `datetime` one alone is ~300), they are zod's parsing implementation rather
 * than the contract, and `format` already says the same thing in a word.
 */
const PATTERN_BEARING_FORMATS: ReadonlySet<string> = new Set([
  'regex', 'starts_with', 'ends_with', 'includes',
])

/**
 * Turn a Zod schema into a JSON Schema object, appending a line to `warnings`
 * for anything it cannot express. `label` names the schema in those warnings
 * (`"POST /posts body.title"`); `io` picks the side of coercing and piped
 * schemas to describe — `input` is what a caller sends, `output` what a parse
 * produces.
 *
 * Returns `undefined` when the node contributes nothing (a bare `z.undefined()`)
 * or could not be read; a caller treats that as "omit this property".
 */
export function toJsonSchema(
  schema: unknown,
  warnings: string[],
  label: string,
  io: SchemaIo,
): JsonSchemaObject | undefined {
  if (warnIfZod3(schema, warnings, label)) {
    return undefined
  }

  if (!isZodSchema(schema)) {
    warnings.push(`${label}: skipped because schema is not a supported Zod schema.`)
    return undefined
  }

  const typeName = typeOf(schema)
  const def = schema._def ?? {}

  // Wrappers add nothing to the rendered type, so they are looked through
  // uniformly. `nullable` is the exception — it renders as a union with null —
  // and so keeps its own case below.
  if (typeName !== 'nullable' && SINGLE_CHILD_WRAPPERS.has(typeName)) {
    const nested = unwrap(schema, io)
    if (!nested) {
      // Reaching a wrapper whose contents cannot be read drops the property,
      // so say so — `z.lazy()` hides its schema behind a getter this walker
      // does not call, and a silently missing property reads as a schema that
      // never declared one.
      warnings.push(`${label}: the contents of a "${typeName}" schema could not be read, so it is omitted.`)
      return undefined
    }
    return toJsonSchema(nested, warnings, label, io)
  }

  switch (typeName) {
    case 'string':
      return { type: 'string', ...stringConstraints(schema) }
    case 'number':
      return {
        type: isIntegerNumber(schema) ? 'integer' : 'number',
        ...numericConstraints(schema),
      }
    case 'boolean':
      return { type: 'boolean' }
    case 'bigint':
      // Constraints are skipped: a bigint's bounds are `bigint` values, and
      // JSON Schema's numeric keywords are JSON numbers.
      return { type: 'integer' }
    case 'date':
      // Same reason as bigint — `z.date().min()` carries a `Date`.
      return { type: 'string', format: 'date-time' }
    case 'undefined':
      return undefined
    case 'null':
      return { type: 'null' }
    case 'literal':
      return literalSchema(def)
    case 'array': {
      const item = arrayElement(def)
      return {
        type: 'array',
        items: toJsonSchema(item, warnings, `${label}[]`, io) ?? {},
        ...lengthConstraints(schema, 'minItems', 'maxItems'),
      }
    }
    case 'object': {
      const details = readObjectSchemaDetails(schema, warnings, label, io)
      if (!details) {
        return { type: 'object' }
      }
      return {
        type: 'object',
        properties: details.properties,
        required: details.required.size > 0 ? Array.from(details.required) : undefined,
      }
    }
    case 'nullable': {
      const nested = unwrap(schema, io)
      const nestedSchema = nested ? toJsonSchema(nested, warnings, label, io) : undefined
      return nestedSchema ? { anyOf: [nestedSchema, { type: 'null' }] } : { type: ['null'] }
    }
    case 'transform':
      warnings.push(`${label}: transform schemas are documented as generic objects.`)
      return { type: 'object' }
    // `z.discriminatedUnion()` produces this same node.
    case 'union': {
      const options = (def.options as unknown[]) ?? []
      const oneOf = options
        .map((option, index) => toJsonSchema(option, warnings, `${label}.option${index}`, io))
        .filter((option): option is JsonSchemaObject => Boolean(option))
      return oneOf.length > 0 ? { oneOf } : undefined
    }
    case 'intersection': {
      const left = toJsonSchema(def.left, warnings, `${label}.left`, io)
      const right = toJsonSchema(def.right, warnings, `${label}.right`, io)
      const allOf = [left, right].filter((value): value is JsonSchemaObject => Boolean(value))
      return allOf.length > 0 ? { allOf } : undefined
    }
    case 'record': {
      const valueType = recordValueType(def)
      return {
        type: 'object',
        additionalProperties: toJsonSchema(valueType, warnings, `${label}.value`, io) ?? true,
      }
    }
    // `z.nativeEnum()` produces this same node, so the values may be numbers.
    case 'enum': {
      const values = enumValues(schema)
      if (values.length === 0) {
        // An empty enum accepts nothing; JSON Schema has no `never`, so a bare
        // string is the least-wrong fallback (the CLI renders `never`).
        return { type: 'string' }
      }
      const hasNumber = values.some((value) => typeof value === 'number')
      const hasString = values.some((value) => typeof value === 'string')
      if (hasNumber && hasString) {
        return { type: ['string', 'number'], enum: values }
      }
      return { type: hasNumber ? 'number' : 'string', enum: values }
    }
    case 'tuple': {
      const items = ((def.items as unknown[]) ?? [])
        .map((item, index) => toJsonSchema(item, warnings, `${label}[${index}]`, io))
        .filter((item): item is JsonSchemaObject => Boolean(item))
      return {
        type: 'array',
        prefixItems: items,
        minItems: items.length,
        maxItems: items.length,
      }
    }
    case 'promise': {
      const nested = innerSchema(def)
      return nested ? toJsonSchema(nested, warnings, label, io) : undefined
    }
    default:
      warnings.push(`${label}: unsupported Zod type "${typeName}".`)
      return undefined
  }
}

/**
 * Take an object schema apart into its properties and the set of keys a caller
 * must supply, looking through any wrappers around it. Warns and returns
 * `undefined` when the schema is absent, not Zod, or not an object once
 * unwrapped — a caller that expands properties into something else (query
 * parameters, merged tool input) has nothing to expand otherwise.
 */
export function readObjectSchema(
  schema: unknown,
  warnings: string[],
  label: string,
  io: SchemaIo,
): ObjectSchemaDetails | undefined {
  if (!schema) {
    return undefined
  }

  if (warnIfZod3(schema, warnings, label)) {
    return undefined
  }

  if (!isZodSchema(schema)) {
    warnings.push(`${label}: skipped because schema is not a supported Zod schema.`)
    return undefined
  }

  const details = readObjectSchemaDetails(schema, warnings, label, io)
  if (!details) {
    warnings.push(`${label}: expected an object schema for parameter expansion.`)
  }
  return details
}

/** Whether this value looks like a Zod schema at all — the gate every walk opens with. */
export function isZodSchema(schema: unknown): schema is ZodSchemaLike {
  if (!schema || typeof schema !== 'object') {
    return false
  }

  return Boolean(getTypeName(schema as ZodSchemaLike))
}

/**
 * Push the v3 refusal warning and report whether it fired. One helper so the
 * composed message cannot drift between the entry points, and so the recursive
 * walks re-check nested nodes — a v3 schema can sit inside a v4 object, and an
 * ungated recursion would document it wrong instead of refusing it.
 */
function warnIfZod3(schema: unknown, warnings: string[], label: string): boolean {
  if (schema && typeof schema === 'object' && isZod3Schema(schema as ZodLike)) {
    warnings.push(`${label}: skipped — ${ZOD3_UNSUPPORTED_MESSAGE}`)
    return true
  }
  return false
}

function readObjectSchemaDetails(
  schema: ZodLike,
  warnings: string[],
  label: string,
  io: SchemaIo,
): ObjectSchemaDetails | undefined {
  // Recursion can surface a v3 node a wrapper was hiding (`z.optional(v3Obj)`
  // passes the entry gate — the wrapper is v4).
  if (warnIfZod3(schema, warnings, label)) {
    return undefined
  }

  if (typeOf(schema) !== 'object') {
    const nested = unwrap(schema, io)
    return nested ? readObjectSchemaDetails(nested, warnings, label, io) : undefined
  }

  const shape = objectShape(schema)
  if (!shape) {
    warnings.push(`${label}: object schema shape could not be read.`)
    return undefined
  }

  const properties: Record<string, JsonSchemaObject> = {}
  const required = new Set<string>()

  for (const [key, value] of Object.entries(shape)) {
    const propertySchema = toJsonSchema(value, warnings, `${label}.${key}`, io)
    if (!propertySchema) {
      continue
    }

    properties[key] = propertySchema
    if (!isOptional(value, io)) {
      required.add(key)
    }
  }

  return { properties, required }
}

/**
 * The schema a wrapper wraps, in the direction being described. Three walks
 * look through wrappers for different reasons — finding the object behind a
 * parameter schema, rendering a type, deciding whether a property may be
 * omitted — and each layers its own handling on top (`nullable` renders as a
 * union; `optional` and friends decide presence). What none of them may do is
 * disagree about which names *are* wrappers, which is why the membership comes
 * from `SINGLE_CHILD_WRAPPERS` rather than a local list. See `pipeSides` for
 * why a pipe resolves per direction.
 */
function unwrap(schema: ZodLike, io: SchemaIo): ZodLike | undefined {
  const def = schema._def ?? {}
  const typeName = typeOf(schema)

  if (typeName === 'pipe') {
    return pipeSide(def, io)
  }

  return SINGLE_CHILD_WRAPPERS.has(typeName) ? innerSchema(def) : undefined
}

function isOptional(schema: ZodLike, io: SchemaIo): boolean {
  switch (typeOf(schema)) {
    case 'optional':
      return true
    // Both fill a missing value in, so the field may be left out of a request
    // but is always present in a response.
    case 'default':
    case 'prefault':
      return io === 'input'
    // Swallows any failure, a missing value included, and substitutes its
    // fallback — so nothing is required of a caller, and a response always
    // carries the field.
    case 'catch':
      return io === 'input'
    // Re-requires a field an inner wrapper made optional, so the walk stops
    // here rather than reading what it wraps.
    case 'nonoptional':
      return false
    // A pipeline runs both stages, so a field may be omitted only if neither
    // stage rejects a missing value. Reading just the side being rendered
    // would document an omission the other stage refuses. Still an
    // approximation in the other direction: a transforming stage can supply a
    // value the next stage accepts, which this reports as required.
    case 'pipe': {
      const { from, to } = pipeSides(schema._def ?? {})
      if (!from) {
        return false
      }
      return to ? isOptional(from, io) && isOptional(to, io) : isOptional(from, io)
    }
    default: {
      const nested = unwrap(schema, io)
      return nested ? isOptional(nested, io) : false
    }
  }
}

function literalSchema(def: Record<string, unknown>): JsonSchemaObject {
  // v4 literals can hold more than one value; only the first is documented
  // here (unlike the CLI's type renderer, which unions all of them).
  const value = literalValues(def)[0]

  if (typeof value === 'string') {
    return { type: 'string', const: value }
  }
  if (typeof value === 'number') {
    return { type: 'number', const: value }
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', const: value }
  }
  if (value === null) {
    return { type: 'null', const: null }
  }

  return {}
}

/**
 * A check value that JSON Schema can carry. The guard is not ceremonial: the
 * same `greater_than` / `min_length` check kinds are attached to `z.date()` and
 * `z.bigint()`, where the bound is a `Date` or a `bigint` — emitting either
 * would produce a keyword whose value is not a JSON number (and, for bigint,
 * one that `JSON.stringify` throws on).
 */
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The tighter of two lower bounds — a schema may carry `.min(2).min(5)`. */
function tightenLower(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.max(current, candidate)
}

/** The tighter of two upper bounds. */
function tightenUpper(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate)
}

/**
 * `min_length` / `max_length` / `length_equals` under whichever pair of
 * keywords the type spells them: strings count characters (`minLength`), arrays
 * count elements (`minItems`). Zod uses the same three check kinds for both.
 */
function lengthConstraints(
  schema: ZodSchemaLike,
  minKey: 'minLength' | 'minItems',
  maxKey: 'maxLength' | 'maxItems',
): JsonSchemaObject {
  const constraints: JsonSchemaObject = {}

  for (const check of schemaChecks(schema)) {
    switch (check.check) {
      case 'min_length': {
        const minimum = numeric(check.minimum)
        if (minimum !== undefined) constraints[minKey] = tightenLower(constraints[minKey], minimum)
        break
      }
      case 'max_length': {
        const maximum = numeric(check.maximum)
        if (maximum !== undefined) constraints[maxKey] = tightenUpper(constraints[maxKey], maximum)
        break
      }
      // `.length(n)` is one check that pins both ends.
      case 'length_equals': {
        const length = numeric(check.length)
        if (length !== undefined) {
          constraints[minKey] = tightenLower(constraints[minKey], length)
          constraints[maxKey] = tightenUpper(constraints[maxKey], length)
        }
        break
      }
      default:
        break
    }
  }

  return constraints
}

/**
 * Every format this node declares, in the order a reader should prefer them.
 *
 * Two sources, because zod has two spellings: the top-level constructors
 * (`z.email()`, `z.int()`) record the format on the node, while the equivalent
 * methods (`z.string().email()`, `z.number().int()`) attach it as a check and
 * leave the node's own field empty. Reading one source loses half the formats
 * an app writes, so both are collected here once rather than in each caller.
 */
function declaredFormats(schema: ZodSchemaLike): string[] {
  const onNode = schemaFormat(schema)
  const onChecks = schemaChecks(schema).flatMap((check) =>
    typeof check.format === 'string' ? [check.format] : [],
  )
  return onNode ? [onNode, ...onChecks] : onChecks
}

/** Whether a `number` node is constrained to whole values, and so is a JSON Schema `integer`. */
function isIntegerNumber(schema: ZodSchemaLike): boolean {
  return declaredFormats(schema).some((format) => INTEGER_NUMBER_FORMATS.has(format))
}

function stringConstraints(schema: ZodSchemaLike): JsonSchemaObject {
  const constraints: JsonSchemaObject = lengthConstraints(schema, 'minLength', 'maxLength')

  for (const format of declaredFormats(schema)) {
    const mapped = JSON_SCHEMA_STRING_FORMATS[format]
    if (mapped && constraints.format === undefined) {
      constraints.format = mapped
    }
  }

  const patterns = schemaChecks(schema).flatMap((check) => {
    if (check.check !== 'string_format') return []
    const format = typeof check.format === 'string' ? check.format : undefined
    if (!format || !PATTERN_BEARING_FORMATS.has(format)) return []
    const pattern = patternSource(check)
    return pattern ? [pattern] : []
  })

  assignWithSurplus(constraints, 'pattern', patterns)

  return constraints
}

/**
 * Put the first value under `keyword` and fold any remainder into `allOf`.
 *
 * JSON Schema allows one `pattern` and one `multipleOf` per schema object, so a
 * node carrying two of either (`z.string().regex(/^a/).startsWith('b')`,
 * `z.number().multipleOf(2).multipleOf(3)`) cannot state both in place. Keeping
 * only the first is not a lesser answer, it is a wrong one: the emitted schema
 * then *accepts values the route rejects*, which is the one direction a derived
 * contract must never be wrong in — an agent handed it will send input that
 * fails validation. `allOf` conjoins, so the surplus stays enforceable.
 *
 * The first value stays on the node rather than going into `allOf` with the
 * rest, so the overwhelmingly common single-constraint case emits flat.
 * (zod's own emitter drops the surplus `multipleOf` outright here.)
 */
function assignWithSurplus(
  constraints: JsonSchemaObject,
  keyword: 'pattern' | 'multipleOf',
  values: Array<string | number>,
): void {
  const [first, ...surplus] = values
  if (first === undefined) {
    return
  }

  // The keyword's value type is narrowed per keyword by the caller's input,
  // which is why the assignment needs the cast the union of both cannot express.
  ;(constraints[keyword] as string | number) = first
  if (surplus.length > 0) {
    constraints.allOf = surplus.map((value) => ({ [keyword]: value }) as JsonSchemaObject)
  }
}

/** A check's regex as a JSON Schema `pattern` — the source, never the `/…/` literal form. */
function patternSource(check: ZodCheckDef): string | undefined {
  return check.pattern instanceof RegExp ? check.pattern.source : undefined
}

function numericConstraints(schema: ZodSchemaLike): JsonSchemaObject {
  const constraints: JsonSchemaObject = {}

  for (const check of schemaChecks(schema)) {
    switch (check.check) {
      // `.min()`/`.gte()` and `.gt()` are one check kind separated by
      // `inclusive`; JSON Schema 2020-12 separates them into two keywords whose
      // values are both numbers (in draft-04 `exclusiveMinimum` was a boolean —
      // that dialect is not what OpenAPI 3.1 or MCP speak).
      case 'greater_than': {
        const value = numeric(check.value)
        if (value === undefined) break
        if (check.inclusive === true) {
          constraints.minimum = tightenLower(constraints.minimum, value)
        } else {
          constraints.exclusiveMinimum = tightenLower(constraints.exclusiveMinimum, value)
        }
        break
      }
      case 'less_than': {
        const value = numeric(check.value)
        if (value === undefined) break
        if (check.inclusive === true) {
          constraints.maximum = tightenUpper(constraints.maximum, value)
        } else {
          constraints.exclusiveMaximum = tightenUpper(constraints.exclusiveMaximum, value)
        }
        break
      }
      default:
        break
    }
  }

  // Two `multipleOf` checks compose to their least common multiple, which one
  // keyword cannot spell — so the surplus is conjoined rather than dropped.
  assignWithSurplus(constraints, 'multipleOf', schemaChecks(schema).flatMap((check) => {
    if (check.check !== 'multiple_of') return []
    const value = numeric(check.value)
    return value === undefined ? [] : [value]
  }))

  return constraints
}
