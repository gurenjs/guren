/**
 * The field readers behind `plan:status` (RFC 0030 §6). A validator's fields go through the
 * Zod → JSON Schema walker agent tools and OpenAPI share, on the export the identity match
 * already imports; a resource's payload goes through the reading `data.gen.ts` is emitted from.
 * Both answer data only; `field-status.ts` judges it.
 */

import {
  innerSchema,
  objectShape,
  pipeSides,
  schemaAt,
  schemaChecks,
  SINGLE_CHILD_WRAPPERS,
  typeOf,
  unwrapSingleChild,
  ZOD3_UNSUPPORTED_MESSAGE,
  type SchemaIo,
  type ZodSchemaLike,
} from '@guren/server/internal/zod-compat'
import { isZodSchema, readObjectSchema, toJsonSchema, type JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import { readResourceDefinitions, type ResourceDefinition } from '../data-types'
import { parseSourceFile } from '../parse-cache'
import { readMember, type PagePropKey } from '../page-props-extractor'
import type { PlanAppUnreadable } from './unreadable'

/** One key of an object schema. A side is absent where the walker could not render the field itself. */
export interface PlanAppSchemaField {
  /** What a client sends. */
  input?: JsonSchemaObject
  /** The validated value, which a plan's field type describes; absent for a field the output object lacks. */
  output?: JsonSchemaObject
  /** The first warning the walker gave on the key itself. */
  unrendered?: string
  /**
   * False when a client may leave the key out. For a key the walker dropped unrendered, read off
   * its outermost presence wrapper (`.required()` adds `nonoptional` over `.optional()`), and absent without one.
   */
  required?: boolean
  /** A pipe or transform in the field's own chain, so its two sides may differ. */
  piped: boolean
  /** A transform, default, prefault or catch in any stage of that chain, which may fill a value the walker reads as missing. */
  fillsMissing: boolean
  /** A refinement on the object, or on the field above its outermost presence wrapper, which may require an omissible key. */
  refinedPresence: boolean
  /** The output reaches a transform, which the walker renders as the value the transform was given. */
  transformed: boolean
}

/**
 * `reshaped`: a transform on the object itself, after every field's checks ran, so no field's output
 * type is its own. `repiped`: the object pipes into a second one, whose keys and presence decide.
 */
export type PlanAppSchemaFields = { fields: Record<string, PlanAppSchemaField>; reshaped: boolean; repiped: boolean } | PlanAppUnreadable

export interface PlanAppResourcePayload {
  className: string
  module: string | null
  file: string
  /** `open` names why a member missing from `members` may still be declared. */
  payload: { members: PagePropKey[]; open?: string } | PlanAppUnreadable
}

/** A walk that throws (a recursive getter schema overflows the walker) leaves this export's fields unread, never the command. */
export function readSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  try {
    return walkSchemaFields(name, value)
  } catch (error) {
    return { unreadable: `${name} could not be walked (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** The wrappers that decide a key's presence on the input side, `nonoptional` re-requiring what an inner one made omissible. */
const INPUT_PRESENCE_WRAPPERS = new Set(['nonoptional', 'optional', 'default', 'prefault', 'catch'])

/** The wrappers that supply a value for a missing key. */
const FILLING_WRAPPERS = new Set(['default', 'prefault', 'catch'])

function walkSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  const warnings: string[] = []
  const object = readObjectSchema(value, warnings, name, 'input')
  const inputObject = object ? objectPath(value as ZodSchemaLike, 'input') : undefined
  const inputShape = inputObject && objectShape(inputObject.at(-1)!)
  if (!object || !inputObject || !inputShape) {
    if (!isZodSchema(value) || warnings.some((warning) => warning.includes(ZOD3_UNSUPPORTED_MESSAGE))) return { unreadable: warnings[0] ?? `${name} is not a zod schema` }
    return { unreadable: `${name} does not reach an object schema this walker can read` }
  }
  const outputObject = objectPath(value as ZodSchemaLike, 'output')?.at(-1)
  const outputShape = (outputObject && objectShape(outputObject)) ?? {}
  const objectRefined = inputObject.some((node) => schemaChecks(node).length > 0)
  const fields: Record<string, PlanAppSchemaField> = {}
  for (const [key, node] of Object.entries(inputShape)) {
    const outputNode = Object.hasOwn(outputShape, key) ? outputShape[key] : undefined
    const input = renderSide(node, key, 'input')
    const output = outputNode ? renderSide(outputNode, key, 'output') : { unrendered: 'the output object does not declare it' }
    const unrendered = input.unrendered ?? output.unrendered
    const chain = wrapperChain(node)
    const types = chain.map(typeOf)
    const presence = types.findIndex((type) => INPUT_PRESENCE_WRAPPERS.has(type))
    const required = key in object.properties ? object.required.has(key) : presence < 0 || types[presence] === 'nonoptional' ? undefined : false
    fields[key] = {
      ...(input.schema ? { input: input.schema } : {}),
      ...(output.schema ? { output: output.schema } : {}),
      ...(unrendered ? { unrendered } : {}),
      ...(required === undefined ? {} : { required }),
      piped: types.includes('pipe') || types.includes('transform'),
      fillsMissing: fillsMissing(node),
      refinedPresence: objectRefined || chain.slice(0, presence + 1).some((wrapper) => schemaChecks(wrapper).length > 0),
      transformed: outputNode !== undefined && reachesTransform(outputNode),
    }
  }
  return { fields, reshaped: reachesTransform(value as ZodSchemaLike), repiped: outputObject !== inputObject.at(-1) }
}

/** The field rendered on one side; a warning labelled with the key itself, not a part below it, means the rendering is not the field's. */
function renderSide(node: ZodSchemaLike, key: string, io: SchemaIo): { schema?: JsonSchemaObject; unrendered?: string } {
  const warnings: string[] = []
  const schema = toJsonSchema(node, warnings, key, io)
  const own = warnings.find((warning) => warning.startsWith(`${key}:`))
  if (own || !schema) return { unrendered: own ?? `the schema walker renders nothing for the ${io} side` }
  return { schema }
}

/** The nodes from a schema down to the object it wraps, unwrapped the way `readObjectSchema()` unwraps it. */
function objectPath(schema: ZodSchemaLike, io: SchemaIo): ZodSchemaLike[] | undefined {
  const path: ZodSchemaLike[] = []
  let node: ZodSchemaLike | undefined = schema
  while (node) {
    path.push(node)
    if (typeOf(node) === 'object') return path
    node = unwrapSingleChild(node, io)
  }
  return undefined
}

/** A field's single-child wrappers, outermost first, down to the first node that is not one. */
function wrapperChain(schema: ZodSchemaLike): ZodSchemaLike[] {
  const chain: ZodSchemaLike[] = []
  let node: ZodSchemaLike | undefined = schema
  while (node) {
    chain.push(node)
    const type = typeOf(node)
    if (type === 'pipe' || !SINGLE_CHILD_WRAPPERS.has(type)) break
    node = innerSchema(node._def ?? {})
  }
  return chain
}

function fillsMissing(schema: ZodSchemaLike): boolean {
  const type = typeOf(schema)
  if (type === 'transform' || FILLING_WRAPPERS.has(type)) return true
  if (type === 'pipe') {
    const def = schema._def ?? {}
    return [schemaAt(def, 'in'), schemaAt(def, 'out')].some((stage) => stage !== undefined && fillsMissing(stage))
  }
  const inner = SINGLE_CHILD_WRAPPERS.has(type) ? innerSchema(schema._def ?? {}) : undefined
  return inner !== undefined && fillsMissing(inner)
}

function reachesTransform(schema: ZodSchemaLike): boolean {
  let node: ZodSchemaLike | undefined = schema
  while (node) {
    const type = typeOf(node)
    if (type === 'transform') return true
    if (type === 'pipe') {
      node = pipeSides(node._def ?? {}).to
      if (!node) return true
    } else if (SINGLE_CHILD_WRAPPERS.has(type)) node = unwrapSingleChild(node, 'output')
    else return false
  }
  return false
}

/** Every resource class codegen discovers, with the members of the payload type it would emit. */
export async function readResourcePayloads(root: string): Promise<PlanAppResourcePayload[] | PlanAppUnreadable> {
  const read = await readResourceDefinitions(root).catch((error: unknown): PlanAppUnreadable => ({ unreadable: error instanceof Error ? error.message : String(error) }))
  if ('unreadable' in read) return read
  return read.definitions.map((definition) => ({
    className: definition.className,
    module: definition.module,
    file: definition.filePath,
    payload: payloadMembers(definition, read.warnings.find((warning) => warning.startsWith(`Resource ${definition.className} (${definition.filePath})`))),
  }))
}

/** `Record<string, …>` adds no named member, so a heritage of that one clause leaves the key set closed. */
function isRecordOnly(heritage: string): boolean {
  if (!/^Record\s*<\s*string\s*,/u.test(heritage)) return false
  const text = heritage.replace(/=>/gu, '=')
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '<') depth += 1
    else if (text[index] === '>' && --depth === 0) return text.slice(index + 1).trim() === ''
  }
  return false
}

function payloadMembers(definition: ResourceDefinition, warning: string | undefined): PlanAppResourcePayload['payload'] {
  const rawType = definition.rawType
  if (rawType === null) return { unreadable: `guren codegen finds no payload type for it${warning ? `: ${warning}` : ''}` }
  if (!rawType.startsWith('{')) return { unreadable: `guren codegen references the payload type (${rawType}) rather than copying it, so its members are not read` }

  const source = `type Payload = ${rawType}\n`
  const statement = parseSourceFile(source, 'payload.ts')?.program.body[0]
  const literal = statement?.type === 'TSTypeAliasDeclaration' ? statement.typeAnnotation : undefined
  if (literal?.type !== 'TSTypeLiteral') return { unreadable: 'the payload type guren codegen copies does not parse as an object type' }

  const members: PagePropKey[] = []
  let open = definition.heritage !== undefined && !isRecordOnly(definition.heritage)
    ? `the payload type extends ${definition.heritage}, whose members the copied body leaves out`
    : undefined
  for (const element of literal.members) {
    // An index signature names no member, as a `Record<string, …>` heritage does not.
    if (element.type === 'TSIndexSignature') continue
    const member = readMember(element, source)
    if (!member) {
      open ??= 'the payload type declares a computed key'
      continue
    }
    const { acceptsUndefined: _acceptsUndefined, ...key } = member
    members.push(key)
  }
  return { members, ...(open ? { open } : {}) }
}
