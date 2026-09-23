/**
 * How a planned validator's and resource's fields compare with what `field-readers.ts` read
 * (RFC 0030 §6). Pure, like the rest of the status. A verdict is `differ` only where the two
 * readings cannot both be true of one field; a transform, a pipe, a union, a refinement or a
 * type this cannot map leaves the property `unknown`.
 */

import type { JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import type { PagePropKey } from '../page-props-extractor'
import type { PlanAppResourcePayload, PlanAppSchemaField, PlanAppSchemaFields } from './field-readers'
import type { PlanResource, PlanValidator } from './schema'
import type { PlanPropertyStatus } from './status'

type PlanValidatorField = PlanValidator['fields'][number]
type PlanResourceField = PlanResource['fields'][number]

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
  const inner = schema.anyOf?.length === 2 && schema.anyOf.some(nullOnly) ? schema.anyOf.find((candidate) => !nullOnly(candidate)) : undefined
  if (inner) return { ...shapeOf(inner), nullable: true }
  const family = typeof schema.type === 'string' && schema.type !== 'null' ? schema.type : undefined
  return { ...(family ? { family } : {}), ...(schema.format ? { format: schema.format } : {}), nullable: false, schema }
}

/**
 * Per planned type, the families that hold it outright and the ones that cannot hold it.
 * A family in neither may carry it under a format or a refinement this does not read.
 */
const VALIDATOR_TYPES: Record<PlanValidatorField['type'], { holds: (shape: FieldShape) => boolean; excludes: Family[] }> = {
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

  const actual = read.fields[field.name]
  if (!actual) return [differ(name, 'declared', 'not declared'), ...details('the schema does not declare it')]
  return [
    match(name, 'declared'),
    typeProperty(`${name} type`, field.type, actual),
    requiredProperty(`${name} required`, field.required, actual),
    ...rules.map(({ property, rule }) => ruleProperty(property, rule, actual)),
  ]
}

/** The planned type describes the validated value, so the output side is read, and `differ` only where both sides are one node. */
function typeProperty(property: string, planned: PlanValidatorField['type'], field: PlanAppSchemaField): PlanPropertyStatus {
  if (field.transformed) return unknown(property, planned, 'the value passes through a transform, whose result type is not read')
  if (!field.output) return unknown(property, planned, field.unrendered ?? 'the output side was not rendered')
  const shape = shapeOf(field.output)
  const type = VALIDATOR_TYPES[planned]
  if (type.holds(shape)) return match(property, planned, describe(shape))
  if (!field.piped && shape.family && type.excludes.includes(shape.family)) return differ(property, planned, describe(shape))
  return unknown(property, planned, `${describe(shape)} may hold a ${planned} under a format, a pipe or a refinement this does not read`)
}

/** Required means a client must send a value: a key it may omit, or one it may send as `null`, is not. */
function requiredProperty(property: string, planned: boolean, field: PlanAppSchemaField): PlanPropertyStatus {
  if (!field.required) return compareBoolean(property, planned, false, 'may be omitted')
  if (!field.input) return unknown(property, String(planned), field.unrendered ?? 'the input side was not rendered')
  const shape = shapeOf(field.input)
  if (shape.nullable) return compareBoolean(property, planned, false, 'accepts null')
  // A union may hold `null` or `undefined` in a member this does not unwrap.
  if (!shape.family) return unknown(property, String(planned), 'the field is a union, which may accept null')
  // The walker reads a pipe as required even where a transforming stage fills in the missing value.
  if (field.transforming) return unknown(property, String(planned), 'a transform in the field may supply a missing value')
  return compareBoolean(property, planned, true, 'must be sent')
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

/**
 * The tightest bound the field states on either rendered side, both stages being enforced. An
 * integer's exclusive bound is the next integer in. A side of another family bounds something else.
 */
function statedBound(field: PlanAppSchemaField, side: 'min' | 'max'): Bound | undefined {
  const outputShape = field.output && !field.transformed ? shapeOf(field.output) : undefined
  const inputShape = field.input ? shapeOf(field.input) : undefined
  const family = outputShape?.family ?? inputShape?.family
  const keywords = family ? BOUND_KEYWORDS[family] : undefined
  if (!keywords) return undefined
  const tighter = (a: Bound, b: Bound): boolean => (side === 'min' ? a.value > b.value || (a.value === b.value && a.exclusive) : a.value < b.value || (a.value === b.value && a.exclusive))
  let bound: Bound | undefined
  for (const shape of [inputShape, outputShape]) {
    if (!shape || shape.family !== family) continue
    for (const keyword of keywords[side]) {
      const stated = shape.schema[keyword]
      if (typeof stated !== 'number') continue
      const exclusive = keyword.startsWith('exclusive')
      const candidate: Bound = family === 'integer' && exclusive && Number.isInteger(stated)
        ? { value: side === 'min' ? stated + 1 : stated - 1, exclusive: false, keyword }
        : { value: stated, exclusive, keyword }
      if (!bound || tighter(candidate, bound)) bound = candidate
    }
  }
  return bound
}

/** A stated bound tighter than the planned one rejects a value the plan accepts; a looser one may be tightened by a refinement. */
function ruleProperty(property: string, rule: string, field: PlanAppSchemaField): PlanPropertyStatus {
  const text = rule.trim()
  const format = FORMAT_RULES[text.toLowerCase()]
  if (format) {
    const formats = [field.input?.format, field.transformed ? undefined : field.output?.format]
    return formats.includes(format) ? match(property, rule, `format ${format}`) : unknown(property, rule, 'no such format is declared, and a refinement this does not read may check it')
  }
  const parsed = BOUND_RULE.exec(text)
  if (!parsed) return unknown(property, rule, 'rule text is compared only as min, max, email, url or uuid')
  const side = parsed[1]!.toLowerCase() as 'min' | 'max'
  const planned = Number(parsed[2])
  const bound = statedBound(field, side)
  if (!bound) return unknown(property, rule, `no ${side} bound is declared, and a refinement this does not read may check it`)
  const said = `${bound.keyword} ${bound.value}`
  if (!bound.exclusive && bound.value === planned) return match(property, rule, said)
  const tighter = side === 'min' ? bound.value > planned || (bound.value === planned && bound.exclusive) : bound.value < planned || (bound.value === planned && bound.exclusive)
  return tighter ? differ(property, rule, said) : unknown(property, rule, `${said} is looser than planned, and a refinement this does not read may tighten it`)
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
  return [match(name, 'declared'), payloadType(`${name} type`, field.type, member)]
}

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'null'])

/** The keyword a union member is an instance of, or `undefined` for anything but a keyword or a literal. */
function keywordOf(member: string): { keyword: string; literal: boolean } | undefined {
  if (PRIMITIVE_TYPES.has(member)) return { keyword: member, literal: false }
  if (member.startsWith('"')) return { keyword: 'string', literal: true }
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
  if (wantKinds.includes(undefined) || haveKinds.includes(undefined)) return asText
  const keywords = (kinds: typeof wantKinds): Set<string> => new Set(kinds.map((kind) => kind!.keyword))
  const literal = [...wantKinds, ...haveKinds].some((kind) => kind!.literal)
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
