/**
 * How a planned validator's and resource's fields compare with what `field-readers.ts` read
 * (RFC 0030 §6). Pure, like the rest of the status. A verdict is `differ` only where the two
 * readings cannot both be true of one field; a node outside the reader's allowlist, a union or a
 * type this cannot map leaves the property `unknown`.
 */

import type { JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import type { PagePropKey } from '../page-props-extractor'
import type { PlanAppResourcePayload, PlanAppSchemaFields } from './field-readers'
import { differ, existenceMatch, match, unknown, type PlanPropertyStatus } from './property-status'
import type { PlanResource, PlanValidator } from './schema'

type PlanValidatorField = PlanValidator['fields'][number]
type PlanResourceField = PlanResource['fields'][number]

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
  const inner = schema.anyOf?.length === 2 && schema.anyOf.some(nullOnly) ? schema.anyOf.find((candidate) => !nullOnly(candidate)) : undefined
  if (inner) return { ...shapeOf(inner), nullable: true }
  const family = typeof schema.type === 'string' && schema.type !== 'null' ? schema.type : undefined
  return { ...(family ? { family } : {}), ...(schema.format ? { format: schema.format } : {}), nullable: false, schema }
}

/**
 * Per planned type, the families that hold it outright and the ones that cannot hold it (a
 * family in neither may carry it under a format or a refinement this does not read), and the
 * families its `min`/`max` is stated in: a string's length, a number's value, an array's size.
 */
const VALIDATOR_TYPES: Record<PlanValidatorField['type'], { holds: (shape: FieldShape) => boolean; excludes: Family[]; bounds: Family[] }> = {
  string: { holds: (shape) => shape.family === 'string', excludes: ['integer', 'number', 'boolean', 'object', 'array'], bounds: ['string'] },
  text: { holds: (shape) => shape.family === 'string', excludes: ['integer', 'number', 'boolean', 'object', 'array'], bounds: ['string'] },
  integer: { holds: (shape) => shape.family === 'integer', excludes: ['string', 'boolean', 'object', 'array'], bounds: ['integer', 'number'] },
  number: { holds: (shape) => shape.family === 'number' || shape.family === 'integer', excludes: ['string', 'boolean', 'object', 'array'], bounds: ['integer', 'number'] },
  decimal: { holds: () => false, excludes: ['boolean', 'object', 'array'], bounds: ['integer', 'number'] },
  boolean: { holds: (shape) => shape.family === 'boolean', excludes: ['string', 'integer', 'number', 'object', 'array'], bounds: [] },
  date: { holds: (shape) => shape.family === 'string' && shape.format === 'date', excludes: ['boolean', 'object', 'array'], bounds: ['string'] },
  datetime: { holds: (shape) => shape.family === 'string' && shape.format === 'date-time', excludes: ['boolean', 'object', 'array'], bounds: ['string'] },
  json: { holds: (shape) => shape.family === 'object' || shape.family === 'array', excludes: [], bounds: ['array'] },
  uuid: { holds: (shape) => shape.family === 'string' && shape.format === 'uuid', excludes: ['integer', 'number', 'boolean', 'object', 'array'], bounds: ['string'] },
}

function describe(shape: FieldShape): string {
  const base = shape.family ? `${shape.family}${shape.format ? ` (${shape.format})` : ''}` : 'a union'
  return shape.nullable ? `${base} | null` : base
}

export function validatorFieldProperties(planned: ReadonlyArray<PlanValidatorField>, read: PlanAppSchemaFields): PlanPropertyStatus[] {
  return planned.flatMap((field) => validatorField(field, read))
}

function validatorField(field: PlanValidatorField, read: PlanAppSchemaFields): PlanPropertyStatus[] {
  const name = `field ${field.name}`
  const rules = field.rules.map((rule) => ({ property: `${name} rule ${rule}`, rule }))
  const details = (reason: string): PlanPropertyStatus[] => [
    unknown(`${name} type`, field.type, reason),
    unknown(`${name} required`, String(field.required), reason),
    ...rules.map(({ property, rule }) => unknown(property, rule, reason)),
  ]
  if ('unreadable' in read) return [unknown(name, 'declared', read.unreadable), ...details(read.unreadable)]

  const actual = Object.hasOwn(read.fields, field.name) ? read.fields[field.name] : undefined
  if (!actual) {
    if (read.open) return [unknown(name, 'declared', read.open), ...details(read.open)]
    return [differ(name, 'declared', 'not declared'), ...details('the schema does not declare it')]
  }
  if ('opaque' in actual) return [existenceMatch(name, 'declared'), ...details(actual.opaque)]
  const shape = shapeOf(actual.output)
  const required = actual.required
  return [
    existenceMatch(name, 'declared'),
    actual.date ? dateType(`${name} type`, field.type) : typeProperty(`${name} type`, field.type, shape),
    typeof required === 'object'
      ? unknown(`${name} required`, String(field.required), required.unknown)
      : compareBoolean(`${name} required`, field.required, required, required ? 'must be sent' : 'may be omitted or sent as null'),
    ...rules.map(({ property, rule }) => (actual.rulesUnread ? unknown(property, rule, actual.rulesUnread) : ruleProperty(property, rule, field.type, shape))),
  ]
}

/** A `Date` is neither the string the walker renders it as nor a calendar date without a time. */
function dateType(property: string, planned: PlanValidatorField['type']): PlanPropertyStatus {
  return planned === 'datetime' ? match(property, planned, 'Date') : unknown(property, planned, `the validated value is a Date, which may carry a ${planned} this does not read`)
}

/** The planned type describes the validated value, which the walker's output side renders. */
function typeProperty(property: string, planned: PlanValidatorField['type'], shape: FieldShape): PlanPropertyStatus {
  const type = VALIDATOR_TYPES[planned]
  if (type.holds(shape)) return match(property, planned, describe(shape))
  if (shape.family && type.excludes.includes(shape.family)) return differ(property, planned, describe(shape))
  return unknown(property, planned, `${describe(shape)} may hold a ${planned} under a format this does not read`)
}

function compareBoolean(property: string, planned: boolean, actual: boolean, said: string): PlanPropertyStatus {
  return planned === actual ? match(property, String(planned), said) : differ(property, String(planned), said)
}

/** `min 1`, `max: 2000`, `max(2000)`: a bound whose keyword the field's family decides. */
const BOUND_RULE = /^(min|max)\s*[:=(]?\s*(-?\d+(?:\.\d+)?)\s*\)?$/iu
const FORMAT_RULES: Record<string, string> = { email: 'email', url: 'uri', uri: 'uri', uuid: 'uuid' }

type BoundKeyword = 'minLength' | 'maxLength' | 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'minItems' | 'maxItems'

const BOUND_KEYWORDS: Partial<Record<Family, { min: BoundKeyword[]; max: BoundKeyword[] }>> = {
  string: { min: ['minLength'], max: ['maxLength'] },
  integer: { min: ['minimum', 'exclusiveMinimum'], max: ['maximum', 'exclusiveMaximum'] },
  number: { min: ['minimum', 'exclusiveMinimum'], max: ['maximum', 'exclusiveMaximum'] },
  array: { min: ['minItems'], max: ['maxItems'] },
}

interface Bound {
  value: number
  exclusive: boolean
  keyword: BoundKeyword
}

/** Whether `a` admits less than `b` on this side; at an equal value an exclusive `a` is the tighter. */
function isTighter(side: 'min' | 'max', a: { value: number; exclusive: boolean }, b: { value: number }): boolean {
  if (a.value === b.value) return a.exclusive
  return side === 'min' ? a.value > b.value : a.value < b.value
}

/** The tightest bound the validated value states in the planned type's unit; an integer's exclusive bound is the next integer in. */
function statedBound(shape: FieldShape, type: PlanValidatorField['type'], side: 'min' | 'max'): Bound | undefined {
  const keywords = shape.family && VALIDATOR_TYPES[type].bounds.includes(shape.family) ? BOUND_KEYWORDS[shape.family] : undefined
  let bound: Bound | undefined
  for (const keyword of keywords?.[side] ?? []) {
    const stated = shape.schema[keyword]
    if (typeof stated !== 'number') continue
    const exclusive = keyword.startsWith('exclusive')
    const candidate: Bound = shape.family === 'integer' && exclusive && Number.isInteger(stated)
      ? { value: side === 'min' ? stated + 1 : stated - 1, exclusive: false, keyword }
      : { value: stated, exclusive, keyword }
    if (!bound || isTighter(side, candidate, bound)) bound = candidate
  }
  return bound
}

/** A stated bound tighter than the planned one rejects a value the plan accepts; a looser one may be tightened by a format or pattern. */
function ruleProperty(property: string, rule: string, type: PlanValidatorField['type'], shape: FieldShape): PlanPropertyStatus {
  const text = rule.trim()
  const format = FORMAT_RULES[text.toLowerCase()]
  if (format) {
    return shape.format === format ? match(property, rule, `format ${format}`) : unknown(property, rule, 'no such format is declared on the validated value')
  }
  const parsed = BOUND_RULE.exec(text)
  if (!parsed) return unknown(property, rule, 'rule text is compared only as min, max, email, url or uuid')
  const side = parsed[1]!.toLowerCase() as 'min' | 'max'
  const planned = Number(parsed[2])
  const bound = statedBound(shape, type, side)
  if (!bound) return unknown(property, rule, `no ${side} bound is declared on the validated value`)
  const said = `${bound.keyword} ${bound.value}`
  if (!bound.exclusive && bound.value === planned) return match(property, rule, said)
  return isTighter(side, bound, { value: planned }) ? differ(property, rule, said) : unknown(property, rule, `${said} is looser than planned, and a format or pattern may tighten it`)
}

export function resourceFieldProperties(planned: ReadonlyArray<PlanResourceField>, read: PlanAppResourcePayload['payload']): PlanPropertyStatus[] {
  return planned.flatMap((field) => resourceField(field, read))
}

function resourceField(field: PlanResourceField, read: PlanAppResourcePayload['payload']): PlanPropertyStatus[] {
  const name = `field ${field.name}`
  const both = (reason: string): PlanPropertyStatus[] => [unknown(name, 'declared', reason), unknown(`${name} type`, field.type, reason)]
  if ('unreadable' in read) return both(read.unreadable)

  const member = read.members.find((candidate) => candidate.name === field.name)
  if (!member) {
    if (read.open) return both(read.open)
    return [differ(name, 'declared', 'not declared'), unknown(`${name} type`, field.type, 'the payload type does not declare it')]
  }
  return [existenceMatch(name, 'declared'), payloadType(`${name} type`, field.type, member)]
}

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'null'])

interface TypeKind {
  keyword: string
  literal: boolean
}

const isKind = (kind: TypeKind | undefined): kind is TypeKind => kind !== undefined

/** The keyword a union member is an instance of, or `undefined` for anything but a keyword or a literal. */
function keywordOf(member: string): TypeKind | undefined {
  if (PRIMITIVE_TYPES.has(member)) return { keyword: member, literal: false }
  if (member.startsWith('"')) return { keyword: 'string', literal: true }
  if (/^-?\d\w*n$/u.test(member)) return { keyword: 'bigint', literal: true }
  if (/^-?\d/u.test(member)) return { keyword: 'number', literal: true }
  if (member === 'true' || member === 'false') return { keyword: 'boolean', literal: true }
  return undefined
}

/**
 * A type as written, compared as a set of union members with `undefined` set aside: an optional
 * member is the payload's presence, which a planned field does not state. `differ` needs every
 * member on both sides to be a keyword or a literal, and a literal only against a keyword it is not.
 */
function payloadType(property: string, planned: string, member: PagePropKey): PlanPropertyStatus {
  if (member.type === undefined) return unknown(property, planned, 'the member carries no type annotation')
  const want = unionMembers(planned)
  const have = unionMembers(member.type)
  const asText = unknown(property, planned, `\`${member.type}\` is compared as text only, and an alias or an object type may name the same`)
  if (!want || !have) return asText
  if (sameSet(want, have)) return match(property, planned, member.type)
  const wantKinds = want.map(keywordOf)
  const haveKinds = have.map(keywordOf)
  if (!wantKinds.every(isKind) || !haveKinds.every(isKind)) return asText
  const keywords = (kinds: TypeKind[]): Set<string> => new Set(kinds.map((kind) => kind.keyword))
  const literal = [...wantKinds, ...haveKinds].some((kind) => kind.literal)
  const wantKeywords = keywords(wantKinds)
  const disjoint = [...keywords(haveKinds)].every((keyword) => !wantKeywords.has(keyword))
  if (!literal || disjoint) return differ(property, planned, member.type)
  return unknown(property, planned, `\`${member.type}\` and \`${planned}\` may describe the same values`)
}

/**
 * Tokens of a type as written: string literals kept whole under one quoting, whitespace and
 * member separators dropped, since the reader collapses a line break between two members.
 */
function typeTokens(type: string): string[] | undefined {
  const tokens: string[] = []
  let word = ''
  const flush = (): void => {
    if (word) tokens.push(word)
    word = ''
  }
  for (let index = 0; index < type.length; index += 1) {
    const char = type[index]!
    if (char === '"' || char === "'" || char === '`') {
      const end = type.indexOf(char, index + 1)
      if (end < 0) return undefined
      flush()
      tokens.push(JSON.stringify(type.slice(index + 1, end)))
      index = end
    } else if (char === '=' && type[index + 1] === '>') {
      flush()
      tokens.push('=>')
      index += 1
    } else if (/[\s;,]/u.test(char)) flush()
    else if ('{}<>()[]|&:?'.includes(char)) {
      flush()
      tokens.push(char)
    } else word += char
  }
  flush()
  return tokens
}

/** Top-level union members with `undefined` dropped, or `undefined` for a type this cannot split. */
function unionMembers(type: string): string[] | undefined {
  const tokens = typeTokens(type)
  if (!tokens) return undefined
  const members: string[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if ('<({['.includes(token)) depth += 1
    else if ('>)}]'.includes(token)) depth -= 1
    if (depth < 0) return undefined
    if (token === '|' && depth === 0) members.push([])
    else members.at(-1)!.push(token)
  }
  const kept = members.map((entry) => entry.join(' ')).filter((entry) => entry !== '' && entry !== 'undefined')
  return depth === 0 && kept.length > 0 ? kept : undefined
}

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((entry) => b.has(entry))
}
