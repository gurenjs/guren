/**
 * The field readers behind `plan:status` (RFC 0030 §6). A validator's fields go through the
 * Zod → JSON Schema walker agent tools and OpenAPI share, on the export the identity match
 * already imports; a resource's payload goes through the reading `data.gen.ts` is emitted from.
 * Both answer data only; `field-status.ts` judges it.
 */

import {
  innerSchema,
  isZod3Schema,
  objectShape,
  pipeSides,
  schemaAt,
  schemaChecks,
  typeOf,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/server/internal/zod-compat'
import { isZodSchema, toJsonSchema, type JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import { readResourceDefinitions, type ResourceDefinition } from '../data-types'
import { parseSourceFile } from '../parse-cache'
import { readMember, type PagePropKey } from '../page-props-extractor'
import type { PlanAppUnreadable } from './unreadable'

/** Whether a client must send a non-null value, or why that cannot be read on every zod version. */
export type Presence = boolean | { unknown: string }

/**
 * One key of an object schema. A verdict beyond the key's existence is read only off a path of
 * nodes whose meaning `ALLOWED_*` below pins; any other node leaves `opaque`, naming it, and
 * nothing else. That is what keeps a node this does not model from reading as a `differ`.
 */
export type PlanAppSchemaField =
  | { opaque: string }
  | {
      /** The validated value as the walker renders it: the output side, a pipe's last stage. */
      output: JsonSchemaObject
      /** The validated value is a `Date`, which the walker renders as a date-time string. */
      date: boolean
      required: Presence
      /** Why `output`'s bounds and formats are not the validated value's; absent when they are. */
      rulesUnread?: string
    }

/** `open` names why a key the object does not declare may still be accepted. */
export type PlanAppSchemaFields = { fields: Record<string, PlanAppSchemaField>; open?: string } | PlanAppUnreadable

export interface PlanAppResourcePayload {
  className: string
  module: string | null
  file: string
  /** `open` names why a member missing from `members` may still be declared. */
  payload: { members: PagePropKey[]; open?: string } | PlanAppUnreadable
}

/**
 * An entry here must mean the same on every zod the apps admit (`^4`, from 4.0): the reader runs
 * against the app's own copy. `nonoptional` is what `.required()` adds over `.optional()`; over a
 * `default` or `prefault` it accepts a missing key before 4.4 and rejects it from 4.4, so that
 * combination is read as unknown.
 */
const ALLOWED_WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'nonoptional'])

/** Leaves whose rendered type is the validated value's. `z.coerce.*` stays a leaf; `z.stringbool()` is a pipe of two. */
const ALLOWED_LEAVES = new Set(['string', 'number', 'boolean', 'bigint', 'date', 'enum'])

/** Checks that only restrict the value, so a stated bound is one it must meet; an `overwrite` only ahead of every bound. */
const ALLOWED_CHECKS = new Set(['min_length', 'max_length', 'length_equals', 'greater_than', 'less_than', 'multiple_of', 'number_format', 'string_format'])

/** A coercion that accepts `null`, and before zod 4.4 a missing key. */
const COERCES_NULL = new Set(['string', 'boolean', 'number', 'date'])

/** zod's own `.trim()`, `.toLowerCase()`, `.toUpperCase()` and `.normalize()`; any other `.overwrite()` may rewrite a value past its bounds. */
const BUILT_IN_OVERWRITES = new Set(['(input) => input.trim()', '(input) => input.toLowerCase()', '(input) => input.toUpperCase()', '(input) => input.normalize(form)'])

/** A walk that throws (a recursive getter schema overflows the walker) leaves this export's fields unread, never the command. */
export function readSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  try {
    return walkSchemaFields(name, value)
  } catch (error) {
    return { unreadable: `${name} could not be walked (${error instanceof Error ? error.message : String(error)})` }
  }
}

function walkSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  if (value !== null && typeof value === 'object' && isZod3Schema(value)) return { unreadable: `${name}: ${ZOD3_UNSUPPORTED_MESSAGE}` }
  if (!isZodSchema(value)) return { unreadable: `${name} is not a zod schema` }
  if (!value._def) return { unreadable: `${name} carries no _def (zod/mini), so its checks and catchall are not visible` }
  const root = objectRoot(value)
  if (!root) return { unreadable: `${name} does not reach an object schema this reader can read` }
  const shape = objectShape(root.object) ?? {}
  const catchall = schemaAt(root.object._def ?? {}, 'catchall')
  const open = catchall && typeOf(catchall) !== 'never' ? `${name} accepts keys it does not declare (a loose object or a catchall)` : undefined
  const fields: Record<string, PlanAppSchemaField> = Object.create(null)
  for (const [key, node] of Object.entries(shape)) {
    const opaque = root.opaque ?? opaqueNode(node, 'field')
    fields[key] = opaque ? { opaque: `${key}: ${opaque}` } : readField(key, node)
  }
  return { fields, ...(open ? { open } : {}) }
}

/**
 * The object a schema is, or wraps. Every verdict but a key's existence needs the export to be
 * the object itself, unrefined: a key the object does not declare is stripped whatever wraps it,
 * but a pipe, a transform, a catch or a refinement around it may change any field's verdict.
 */
function objectRoot(value: ZodSchemaLike): { object: ZodSchemaLike; opaque?: string } | undefined {
  let node: ZodSchemaLike | undefined = value
  const around: string[] = []
  while (node && typeOf(node) !== 'object') {
    around.push(typeOf(node))
    node = typeOf(node) === 'pipe' ? pipeSides(node._def ?? {}).from : innerSchema(node._def ?? {})
  }
  if (!node) return undefined
  if (around.length > 0) return { object: node, opaque: `the object is wrapped in ${around.join(' > ')}` }
  const checks = uncheckedKinds(node, false, false)
  return checks ? { object: node, opaque: `the object carries ${checks}` } : { object: node }
}

/**
 * Why a field's node is outside the allowlist, or `undefined` when every node on it is in. A pipe's
 * stages must be plain leaves, since a wrapper inside one could fill a value in between; only the
 * stage whose bounds are read (`field` or a pipe's `out`) needs its overwrites ahead of them.
 */
function opaqueNode(node: ZodSchemaLike, role: 'field' | 'in' | 'out'): string | undefined {
  if (!node._def) return 'a node carries no _def (zod/mini)'
  const type = typeOf(node)
  const checks = uncheckedKinds(node, ALLOWED_LEAVES.has(type), role !== 'in')
  if (checks) return `a ${type} carries ${checks}`
  if (ALLOWED_LEAVES.has(type)) return undefined
  if (role !== 'field') return `a pipe has a ${type} stage`
  if (type === 'pipe') {
    const def = node._def ?? {}
    const stages = [schemaAt(def, 'in'), schemaAt(def, 'out')] as const
    if (!stages[0] || !stages[1]) return 'a pipe has a missing stage'
    return opaqueNode(stages[0], 'in') ?? opaqueNode(stages[1], 'out')
  }
  const inner = ALLOWED_WRAPPERS.has(type) ? innerSchema(node._def ?? {}) : undefined
  return inner ? opaqueNode(inner, 'field') : `it holds a ${type}, whose meaning this reader does not model`
}

/** The check kinds on a node outside `ALLOWED_CHECKS`, or an `overwrite` after a bound when `ordered`; `undefined` when none. */
function uncheckedKinds(node: ZodSchemaLike, leaf: boolean, ordered: boolean): string | undefined {
  const checks = schemaChecks(node).map((check) => check.check)
  const outside = checks.filter((check) => !leaf || (check !== 'overwrite' && !ALLOWED_CHECKS.has(check)))
  if (outside.length > 0) return `a check this reader does not model (${[...new Set(outside)].join(', ')})`
  const bounded = checks.findIndex((check) => check !== 'overwrite')
  return ordered && bounded >= 0 && checks.lastIndexOf('overwrite') > bounded ? 'an overwrite (such as .trim()) after a bound' : undefined
}

/**
 * A field whose every node is allowed: its presence read off its wrappers, its type off the
 * walker's output side. A pipe's out stage validates the final value, so its type holds, but a
 * step may run between the stages (a codec's decode), so its presence and rules are not read.
 */
function readField(key: string, node: ZodSchemaLike): PlanAppSchemaField {
  const warnings: string[] = []
  const output = toJsonSchema(node, warnings, key, 'output')
  if (!output || warnings.length > 0) return { opaque: warnings[0] ?? `${key}: the schema walker renders nothing for it` }
  let decider: string | undefined
  let filled = false
  let nullable = false
  let leaf = node
  while (ALLOWED_WRAPPERS.has(typeOf(leaf))) {
    const type = typeOf(leaf)
    if (type === 'nullable') nullable = true
    else if (decider === undefined) decider = type
    else if (type === 'default' || type === 'prefault') filled = true
    leaf = innerSchema(leaf._def ?? {})!
  }
  const piped = typeOf(leaf) === 'pipe'
  const read = piped ? schemaAt(leaf._def ?? {}, 'out')! : leaf
  const date = typeOf(read) === 'date'
  if (piped) {
    const reason = 'a pipe or codec may run a step between its stages'
    return { output, date, required: nullable || (decider !== undefined && decider !== 'nonoptional') ? false : { unknown: reason }, rulesUnread: reason }
  }
  const custom = schemaChecks(leaf).some((check) => check.check === 'overwrite' && !BUILT_IN_OVERWRITES.has(String(check.tx)))
  const rules = custom ? { rulesUnread: 'a custom .overwrite() may rewrite the value past its bounds' } : {}
  return { output, date, required: requiredOf(leaf, decider, filled, nullable), ...rules }
}

function requiredOf(leaf: ZodSchemaLike, decider: string | undefined, filled: boolean, nullable: boolean): Presence {
  if (nullable || (decider !== undefined && decider !== 'nonoptional')) return false
  if (decider === 'nonoptional' && filled) return { unknown: 'nonoptional over a default or prefault accepts a missing key before zod 4.4 and rejects it from 4.4' }
  if (leaf._def?.coerce === true && COERCES_NULL.has(typeOf(leaf))) return { unknown: 'a coercion accepts null, and before zod 4.4 a missing key' }
  return true
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
