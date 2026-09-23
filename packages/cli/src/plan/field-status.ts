/**
 * How a planned validator's and resource's fields compare with what `field-readers.ts` read
 * (RFC 0030 §6). Pure, like the rest of the status. A verdict is `differ` only where the two
 * readings cannot both be true of one field; a refinement, a union or a type this cannot map
 * leaves the property `unknown`.
 */

import type { JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import type { PagePropKey } from '../page-props-extractor'
import type { PlanAppUnreadable } from './app-state'
import type { PlanAppResourcePayload, PlanAppSchemaFields } from './field-readers'
import type { PlanColumn, PlanResource, PlanValidator } from './schema'
import type { PlanPropertyStatus } from './status'

type PlanValidatorField = PlanValidator['fields'][number]
type PlanColumnType = PlanColumn['type']

const match = (property: string, planned: string, actual = planned): PlanPropertyStatus => ({ property, verdict: 'match', planned, actual })
const differ = (property: string, planned: string, actual: string): PlanPropertyStatus => ({ property, verdict: 'differ', planned, actual })
const unknown = (property: string, planned: string, reason: string): PlanPropertyStatus => ({ property, verdict: 'unknown', planned, reason })

/** One JSON value family, the level at which two types can be told apart without a guess. */
type Family = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'

interface FieldShape {
  /** Absent for a union, a type list or a node the walker left untyped. */
  family?: Family
  format?: string
  nullable: boolean
  schema: JsonSchemaObject
}

function shapeOf(schema: JsonSchemaObject): FieldShape {
  const nullOnly = (candidate: JsonSchemaObject): boolean => candidate.type === 'null' || (Array.isArray(candidate.type) && candidate.type.length === 1 && candidate.type[0] === 'null')
  if (schema.anyOf?.length === 2 && schema.anyOf.some(nullOnly)) {
    return { ...shapeOf(schema.anyOf.find((candidate) => !nullOnly(candidate))!), nullable: true }
  }
  const family = typeof schema.type === 'string' && schema.type !== 'null' ? schema.type : undefined
  return { ...(family ? { family } : {}), ...(schema.format ? { format: schema.format } : {}), nullable: false, schema }
}

/**
 * Per planned type, the families that hold it outright and the ones that cannot hold it.
 * A family in neither may carry it under a format or a refinement this does not read.
 */
const VALIDATOR_TYPES: Record<PlanColumnType, { holds: (shape: FieldShape) => boolean; excludes: Family[] }> = {
  string: { holds: (shape) => shape.family === 'string', excludes: ['integer', 'number', 'boolean', 'object', 'array'] },
  text: { holds: (shape) => shape.family === 'string', excludes: ['integer', 'number', 'boolean', 'object', 'array'] },
  integer: { holds: (shape) => shape.family === 'integer', excludes: ['string', 'boolean', 'object', 'array'] },
  number: { holds: (shape) => shape.family === 'number' || shape.family === 'integer', excludes: ['string', 'boolean', 'object', 'array'] },
  decimal: { holds: () => false, excludes: ['boolean', 'object', 'array'] },
  boolean: { holds: (shape) => shape.family === 'boolean', excludes: ['string', 'integer', 'number', 'object', 'array'] },
  date: { holds: (shape) => shape.family === 'string' && shape.format === 'date', excludes: ['boolean', 'object', 'array'] },
  datetime: { holds: (shape) => shape.family === 'string' && shape.format === 'date-time', excludes: ['boolean', 'object', 'array'] },
  json: { holds: (shape) => shape.family === 'object' || shape.family === 'array', excludes: [] },
  uuid: { holds: (shape) => shape.family === 'string' && shape.format === 'uuid', excludes: ['integer', 'number', 'boolean', 'object', 'array'] },
}

function describe(shape: FieldShape): string {
  const base = shape.family ? `${shape.family}${shape.format ? ` (${shape.format})` : ''}` : 'a union'
  return shape.nullable ? `${base} | null` : base
}

export function validatorFieldProperties(planned: ReadonlyArray<PlanValidatorField>, read: PlanAppSchemaFields | undefined, whyUnread: string): PlanPropertyStatus[] {
  return planned.flatMap((field) => validatorField(field, read, whyUnread))
}

function validatorField(field: PlanValidatorField, read: PlanAppSchemaFields | undefined, whyUnread: string): PlanPropertyStatus[] {
  const name = `field ${field.name}`
  const rules = field.rules.map((rule) => ({ property: `${name} rule ${rule}`, rule }))
  const all = (reason: string): PlanPropertyStatus[] => [
    unknown(name, 'declared', reason),
    unknown(`${name} type`, field.type, reason),
    unknown(`${name} required`, String(field.required), reason),
    ...rules.map(({ property, rule }) => unknown(property, rule, reason)),
  ]
  if (!read) return all(whyUnread)
  if ('unreadable' in read) return all(read.unreadable)

  const warned = read.unrendered[field.name]
  if (warned !== undefined) return all(`the schema walker could not read it: ${warned}`)
  const schema = read.properties[field.name]
  if (!schema) {
    const absent = 'the schema does not declare it'
    return [differ(name, 'declared', 'not declared'), ...all(absent).slice(1)]
  }

  const shape = shapeOf(schema)
  const properties = [match(name, 'declared')]
  const type = VALIDATOR_TYPES[field.type]
  if (type.holds(shape)) properties.push(match(`${name} type`, field.type, describe(shape)))
  else if (shape.family && type.excludes.includes(shape.family)) properties.push(differ(`${name} type`, field.type, describe(shape)))
  else properties.push(unknown(`${name} type`, field.type, `${describe(shape)} may hold a ${field.type} under a format or a refinement this does not read`))

  properties.push(requiredProperty(`${name} required`, field.required, read.required.includes(field.name), shape))
  properties.push(...rules.map(({ property, rule }) => ruleProperty(property, rule, shape)))
  return properties
}

/** Required means a client must send a value: a key it may omit, or one it may send as `null`, is not. */
function requiredProperty(property: string, planned: boolean, keyRequired: boolean, shape: FieldShape): PlanPropertyStatus {
  if (!keyRequired || shape.nullable) return compareBoolean(property, planned, false, keyRequired ? 'accepts null' : 'may be omitted')
  // A union may hold `null` or `undefined` in a member this does not unwrap.
  if (!shape.family) return unknown(property, String(planned), 'the field is a union, which may accept null')
  return compareBoolean(property, planned, true, 'must be sent')
}

function compareBoolean(property: string, planned: boolean, actual: boolean, said: string): PlanPropertyStatus {
  return planned === actual ? match(property, String(planned), said) : differ(property, String(planned), said)
}

/** `min 1`, `max: 2000`, `max(2000)`: a bound whose keyword the field's family decides. */
const BOUND_RULE = /^(min|max)\s*[:=(]?\s*(-?\d+(?:\.\d+)?)\s*\)?$/iu
const FORMAT_RULES: Record<string, string> = { email: 'email', url: 'uri', uri: 'uri', uuid: 'uuid' }

const BOUND_KEYWORDS: Partial<Record<Family, { min: keyof JsonSchemaObject; max: keyof JsonSchemaObject }>> = {
  string: { min: 'minLength', max: 'maxLength' },
  integer: { min: 'minimum', max: 'maximum' },
  number: { min: 'minimum', max: 'maximum' },
  array: { min: 'minItems', max: 'maxItems' },
}

function ruleProperty(property: string, rule: string, shape: FieldShape): PlanPropertyStatus {
  const text = rule.trim()
  const format = FORMAT_RULES[text.toLowerCase()]
  if (format) {
    return shape.format === format ? match(property, rule, `format ${format}`) : unknown(property, rule, 'no such format is declared, and a refinement this does not read may check it')
  }
  const bound = BOUND_RULE.exec(text)
  const keywords = shape.family ? BOUND_KEYWORDS[shape.family] : undefined
  if (!bound || !keywords) return unknown(property, rule, bound ? 'the field has no single type to read a bound of' : 'rule text is compared only as min, max, email, url or uuid')
  const keyword = keywords[bound[1]!.toLowerCase() as 'min' | 'max']
  const actual = shape.schema[keyword]
  if (typeof actual !== 'number') return unknown(property, rule, `no ${keyword} is declared, and a refinement this does not read may check it`)
  return actual === Number(bound[2]) ? match(property, rule, `${keyword} ${actual}`) : differ(property, rule, `${keyword} ${actual}`)
}

export function resourceFieldProperties(planned: PlanResource['fields'], read: PlanAppResourcePayload['payload'] | undefined, whyUnread: string): PlanPropertyStatus[] {
  return planned.flatMap((field) => resourceField(field, read, whyUnread))
}

function resourceField(field: PlanResource['fields'][number], read: PlanAppResourcePayload['payload'] | undefined, whyUnread: string): PlanPropertyStatus[] {
  const name = `field ${field.name}`
  const both = (reason: string): PlanPropertyStatus[] => [unknown(name, 'declared', reason), unknown(`${name} type`, field.type, reason)]
  if (!read) return both(whyUnread)
  if (isUnreadablePayload(read)) return both(read.unreadable)

  const member = read.members.find((candidate) => candidate.name === field.name)
  if (!member) {
    if (read.open) return both(read.open)
    return [differ(name, 'declared', 'not declared'), unknown(`${name} type`, field.type, 'the payload type does not declare it')]
  }
  return [match(name, 'declared'), payloadType(`${name} type`, field.type, member)]
}

function isUnreadablePayload(read: PlanAppResourcePayload['payload']): read is PlanAppUnreadable {
  return 'unreadable' in read
}

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'null'])

/**
 * A type as written, compared as a set of union members with `undefined` set aside: an optional
 * member is the payload's presence, which a planned field does not state. `differ` only when both
 * sides are primitive keywords or literals, since an alias or an object type may name the same thing.
 */
function payloadType(property: string, planned: string, member: PagePropKey): PlanPropertyStatus {
  if (member.type === undefined) return unknown(property, planned, 'the member carries no type annotation')
  const want = unionMembers(planned)
  const have = unionMembers(member.type)
  if (want && have && sameSet(want, have)) return match(property, planned, member.type)
  const primitive = (members: string[] | undefined): boolean => members !== undefined && members.every((entry) => PRIMITIVE_TYPES.has(entry) || /^(['"`]).*\1$|^-?\d/u.test(entry))
  if (primitive(want) && primitive(have)) return differ(property, planned, member.type)
  return unknown(property, planned, `\`${member.type}\` is compared as text only, and an alias or an object type may name the same`)
}

/**
 * Top-level union members with `undefined` dropped, or `undefined` for a type this cannot split.
 * Whitespace and member separators are removed: the reader collapses a line break between two
 * members to a space, so `{ a: string; b: string }` reaches here without its `;`.
 */
function unionMembers(type: string): string[] | undefined {
  const members: string[] = []
  let depth = 0
  let current = ''
  // An arrow's `>` closes nothing.
  for (const char of type.replace(/[\s;,]+/gu, '').replace(/=>/gu, '=')) {
    if ('<({['.includes(char)) depth += 1
    else if ('>)}]'.includes(char)) depth -= 1
    if (depth < 0) return undefined
    if (char === '|' && depth === 0) {
      members.push(current)
      current = ''
    } else current += char
  }
  members.push(current)
  const kept = members.filter((entry) => entry !== '' && entry !== 'undefined')
  return depth === 0 && kept.length > 0 ? kept : undefined
}

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((entry) => b.has(entry))
}
