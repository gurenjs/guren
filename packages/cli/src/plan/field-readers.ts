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
  /** Why a side is absent. */
  unrendered?: string
  /** The walker's presence: false when a client may leave the key out. */
  required: boolean
  /** A pipe or transform in the field's own chain, so its two sides may differ. */
  piped: boolean
  /** A transform in any stage of that chain, which may supply a value the walker reads as missing. */
  transforming: boolean
  /** The output reaches a transform, which the walker renders as the value the transform was given. */
  transformed: boolean
}

export type PlanAppSchemaFields = { fields: Record<string, PlanAppSchemaField> } | PlanAppUnreadable

export interface PlanAppResourcePayload {
  className: string
  module: string | null
  file: string
  /** `open` names why a member missing from `members` may still be declared. */
  payload: { members: PagePropKey[]; open?: string } | PlanAppUnreadable
}

export function readSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  const warnings: string[] = []
  const object = readObjectSchema(value, warnings, name, 'input')
  const inputShape = object && objectShapeOf(value as ZodSchemaLike, 'input')
  if (!object || !inputShape) {
    if (warnings.some((warning) => warning.includes(ZOD3_UNSUPPORTED_MESSAGE)) || !isZodSchema(value)) return { unreadable: warnings[0] ?? `${name} is not a zod schema` }
    return { unreadable: `${name} does not reach an object schema this walker can read` }
  }
  const outputShape = objectShapeOf(value as ZodSchemaLike, 'output') ?? {}
  const fields: Record<string, PlanAppSchemaField> = {}
  for (const [key, node] of Object.entries(inputShape)) {
    const input = renderSide(node, key, 'input')
    const output = key in outputShape ? renderSide(outputShape[key]!, key, 'output') : { unrendered: 'the output object does not declare it' }
    const unrendered = input.unrendered ?? output.unrendered
    fields[key] = {
      ...(input.schema ? { input: input.schema } : {}),
      ...(output.schema ? { output: output.schema } : {}),
      ...(unrendered ? { unrendered } : {}),
      required: object.required.has(key),
      piped: wrapperChain(node).some((type) => type === 'pipe' || type === 'transform'),
      transforming: hasTransformStage(node),
      transformed: key in outputShape && reachesTransform(outputShape[key]!),
    }
  }
  return { fields }
}

/** The field rendered on one side; a warning labelled with the key itself, not a part below it, means the rendering is not the field's. */
function renderSide(node: ZodSchemaLike, key: string, io: SchemaIo): { schema?: JsonSchemaObject; unrendered?: string } {
  const warnings: string[] = []
  const schema = toJsonSchema(node, warnings, key, io)
  const own = warnings.find((warning) => warning.startsWith(`${key}:`))
  if (own || !schema) return { unrendered: own ?? `the schema walker renders nothing for the ${io} side` }
  return { schema }
}

/** The object a schema wraps, unwrapped the way `readObjectSchema()` unwraps it. */
function objectShapeOf(schema: ZodSchemaLike, io: SchemaIo): Record<string, ZodSchemaLike> | undefined {
  let node: ZodSchemaLike | undefined = schema
  while (node && typeOf(node) !== 'object') node = unwrapSingleChild(node, io)
  return node ? objectShape(node) : undefined
}

/** The type names of a field's single-child wrappers, down to the first node that is not one. */
function wrapperChain(schema: ZodSchemaLike): string[] {
  const types: string[] = []
  let node: ZodSchemaLike | undefined = schema
  while (node) {
    const type = typeOf(node)
    types.push(type)
    if (type === 'pipe' || !SINGLE_CHILD_WRAPPERS.has(type)) break
    node = innerSchema(node._def ?? {})
  }
  return types
}

function hasTransformStage(schema: ZodSchemaLike): boolean {
  const type = typeOf(schema)
  if (type === 'transform') return true
  if (type === 'pipe') {
    const def = schema._def ?? {}
    return [schemaAt(def, 'in'), schemaAt(def, 'out')].some((stage) => stage !== undefined && hasTransformStage(stage))
  }
  const inner = SINGLE_CHILD_WRAPPERS.has(type) ? innerSchema(schema._def ?? {}) : undefined
  return inner !== undefined && hasTransformStage(inner)
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
  let read: Awaited<ReturnType<typeof readResourceDefinitions>>
  try {
    read = await readResourceDefinitions(root)
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }
  return read.definitions.map((definition) => ({
    className: definition.className,
    module: definition.module,
    file: definition.filePath,
    payload: payloadMembers(definition, read.warnings.find((warning) => warning.includes(`(${definition.filePath})`))),
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
