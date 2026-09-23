/**
 * The field readers behind `plan:status` (RFC 0030 §6). A validator's fields go through the
 * Zod → JSON Schema walker agent tools and OpenAPI share, on the export the identity match
 * already imports; a resource's payload goes through the reading `data.gen.ts` is emitted from.
 * Both answer data only; `field-status.ts` judges it.
 */

import { isZodSchema, readObjectSchema, type JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import { readResourceDefinitions, type ResourceDefinition } from '../data-types'
import { parseSourceFile } from '../parse-cache'
import { readMember, type PagePropKey } from '../page-props-extractor'
import type { PlanAppUnreadable } from './app-state'

/** An object schema's input side, what a client may send; `unrendered` is the walker's warning per field it could not render. */
export type PlanAppSchemaFields =
  | { properties: Record<string, JsonSchemaObject>; required: string[]; unrendered: Record<string, string> }
  | PlanAppUnreadable

export interface PlanAppResourcePayload {
  className: string
  module: string | null
  file: string
  /** `open` names why a member missing from `members` may still be declared. */
  payload: { members: PagePropKey[]; open?: string } | PlanAppUnreadable
}

/** The walker's refusal when nothing reaches an object, which speaks of OpenAPI's parameters. */
const NOT_AN_OBJECT_WARNING = 'expected an object schema'

export function readSchemaFields(name: string, value: unknown): PlanAppSchemaFields {
  if (!isZodSchema(value)) return { unreadable: `${name} is not a zod schema` }
  const warnings: string[] = []
  const details = readObjectSchema(value, warnings, name, 'input')
  if (!details) {
    const reason = warnings.find((warning) => !warning.includes(NOT_AN_OBJECT_WARNING))
    return { unreadable: reason ?? `${name} does not reach an object schema this walker can read` }
  }
  // The walker labels a field `<export>.<key>`, then `.option0`, `[]` or `.value` below it.
  const unrendered: Record<string, string> = {}
  for (const warning of warnings) {
    const key = warning.startsWith(`${name}.`) ? /^[^.[:]+/u.exec(warning.slice(name.length + 1))?.[0] : undefined
    if (key !== undefined) unrendered[key] ??= warning
  }
  return { properties: details.properties, required: [...details.required], unrendered }
}

/** Every resource class codegen discovers, with the members of the payload type it would emit. */
export async function readResourcePayloads(root: string): Promise<PlanAppResourcePayload[] | PlanAppUnreadable> {
  let definitions: ResourceDefinition[]
  try {
    definitions = await readResourceDefinitions(root)
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }
  return definitions.map((definition) => ({
    className: definition.className,
    module: definition.module,
    file: definition.filePath,
    payload: payloadMembers(definition),
  }))
}

/** `Record<string, …>` adds no named member, so it leaves the key set closed. */
const OPEN_HERITAGE = /^(?!Record\s*<\s*string\s*,)/u

function payloadMembers(definition: ResourceDefinition): PlanAppResourcePayload['payload'] {
  const rawType = definition.rawType
  if (rawType === null) return { unreadable: 'guren codegen finds no payload type for it (its warning says why)' }
  if (!rawType.startsWith('{')) return { unreadable: `guren codegen references the payload type (${rawType}) rather than copying it, so its members are not read` }

  const prefix = 'type Payload = '
  const source = `${prefix}${rawType}\n`
  const statement = parseSourceFile(source, 'payload.ts')?.program.body[0]
  const literal = statement?.type === 'TSTypeAliasDeclaration' ? statement.typeAnnotation : undefined
  if (literal?.type !== 'TSTypeLiteral') return { unreadable: 'the payload type guren codegen copies does not parse as an object type' }

  const members: PagePropKey[] = []
  let open = definition.heritage !== undefined && OPEN_HERITAGE.test(definition.heritage)
    ? `the payload type extends ${definition.heritage}, whose members the copied body leaves out`
    : undefined
  for (const element of literal.members) {
    const member = readMember(element, source)
    if (member) members.push({ name: member.name, optional: member.optional, ...(member.type ? { type: member.type } : {}) })
    else open ??= 'the payload type declares an index signature or a computed key'
  }
  return { members, ...(open ? { open } : {}) }
}
