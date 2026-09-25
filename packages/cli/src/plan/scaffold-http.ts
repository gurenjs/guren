/**
 * The validator, resource and policy half of the plan-driven scaffold (RFC 0030 §5), pure like
 * `scaffold.ts`, which calls it. Each is written in the one shape `plan:status` reads back: a
 * validator field through `field-readers.ts`'s zod allowlist, a resource payload as `guren
 * codegen` copies it, a policy's abilities as methods of a class extending `Policy`.
 */

import { POLICIES_DIR, PROVIDERS_DIR, RESOURCES_DIR, VALIDATORS_DIR } from '../discovery'
import { buildPolicySource } from '../make-policy'
import { buildResourceSource } from '../make-resource'
import { ZOD_IMPORT, zodObjectExport } from '../make-validator'
import { parseSourceFile } from '../parse-cache'
import { COLUMN_RECORD_TYPES, quoteString } from '../schema-columns'
import type { SchemaDialect } from '../schema-parser'
import { isBindingName, isIdentifier, propertyAccess, quoteObjectKey } from '../utils'
import { BOUND_RULE, FORMAT_RULES, unionMembers } from './field-status'
import type { PlanColumn, PlanDraft, PlanModel, PlanPolicy, PlanResource, PlanValidator } from './schema'

/** A planned property written in no form a reader compares, or as a stub: the http step finishes it. */
export interface PlanScaffoldUnwritten {
  element: string
  detail: string
  reason: string
}

/** A step's added validators, resources and policies, before any is left to the http step. */
export interface PlanScaffoldAdded {
  validators: PlanValidator[]
  resources: PlanResource[]
  policies: PlanPolicy[]
}

/** Why each added element is left to the http step, where it is not written. */
export function httpLeftReasons(added: PlanScaffoldAdded, models: readonly PlanModel[]): Map<string, string> {
  const reasons = new Map<string, string>()
  const modelIds = new Set(models.map((model) => model.id))
  if (models.length === 0) {
    for (const validator of added.validators) reasons.set(validator.id, 'the step adds no model to name its validator file after')
  }
  const onModel = (model: string): string | undefined =>
    modelIds.has(model) ? undefined : `its model ${model} is not one this step adds, so the model's record type is not known to exist`
  for (const resource of added.resources) {
    const why = onModel(resource.model) ?? resource.fields.map((field) => unwritableType(field.type)).find((reason) => reason !== undefined)
    if (why) reasons.set(resource.id, why)
  }
  for (const policy of added.policies) {
    const why = onModel(policy.model)
    if (why) reasons.set(policy.id, why)
  }
  return reasons
}

const TYPE_KEYWORDS = new Set([
  'TSStringKeyword',
  'TSNumberKeyword',
  'TSBooleanKeyword',
  'TSBigIntKeyword',
  'TSNullKeyword',
  'TSUndefinedKeyword',
  'TSUnknownKeyword',
  'TSAnyKeyword',
  'TSNeverKeyword',
  'TSObjectKeyword',
  'TSLiteralType',
])

/** Global generic types a payload may name without an import. */
const GLOBAL_TYPES = new Set(['Array', 'ReadonlyArray', 'Record', 'Date'])

/**
 * Why a planned payload type cannot be written into the resource file as is: it names a type
 * the file would have to import (`UserResourceData`), it does not parse as one type, or it holds
 * a comment, which would swallow the `,` written after the type in `toArray()`.
 */
function unwritableType(text: string): string | undefined {
  const file = parseSourceFile(`type Planned = ${text}\n`, 'payload.ts')
  const alias = file?.program.body.length === 1 ? file.program.body[0] : undefined
  if (alias?.type !== 'TSTypeAliasDeclaration') return `its field type \`${text}\` does not parse as one type`
  if ((file?.comments?.length ?? 0) > 0) return `its field type \`${text}\` holds a comment, which would swallow the code written after the type`
  let offending: string | undefined
  const walk = (node: { type: string; [key: string]: unknown }): boolean => {
    if (TYPE_KEYWORDS.has(node.type)) return true
    if (node.type === 'TSUnionType') return (node.types as Array<typeof node>).every(walk)
    if (node.type === 'TSArrayType') return walk(node.elementType as typeof node)
    if (node.type === 'TSParenthesizedType') return walk(node.typeAnnotation as typeof node)
    if (node.type === 'TSTypeReference') {
      const name = node.typeName as { type: string; name?: string }
      const params = (node.typeParameters as { params: Array<typeof node> } | undefined)?.params ?? []
      if (name.type === 'Identifier' && GLOBAL_TYPES.has(name.name!)) return params.every(walk)
      offending = name.name ?? 'a qualified name'
      return false
    }
    offending = `a ${node.type.replace(/^TS/u, '')}`
    return false
  }
  if (walk(alias.typeAnnotation as unknown as { type: string })) return undefined
  return `its field type \`${text}\` names ${offending}, which the resource file would have to import`
}

/** `Policy`'s own members: an ability of one of these names replaces the hook or the helper. */
const POLICY_MEMBERS = new Set(['constructor', 'before', 'allow', 'deny', 'denyWithStatus', 'denyAsNotFound'])

export function policyRefusals(policy: PlanPolicy, declared: readonly string[]): string[] {
  const refusals: string[] = []
  if (!isBindingName(policy.name)) refusals.push(`${policy.id} is named "${policy.name}", which a class cannot be named.`)
  if (declared.includes(policy.name)) refusals.push(`${policy.id}: the application already declares a ${policy.name} policy.`)
  const seen = new Set<string>()
  for (const { name } of policy.abilities) {
    if (!isIdentifier(name)) refusals.push(`${policy.id}'s ability "${name}" is not a name a method can take, which is how the gate finds an ability.`)
    else if (POLICY_MEMBERS.has(name)) refusals.push(`${policy.id}'s ability "${name}" would replace Policy's own ${name}(). Rename the ability (plan:revise).`)
    if (seen.has(name)) refusals.push(`${policy.id} plans the ability "${name}" twice.`)
    seen.add(name)
  }
  return refusals
}

export function resourceRefusals(resource: PlanResource, declared: readonly string[]): string[] {
  const refusals: string[] = []
  if (!/^[A-Z][A-Za-z0-9]*Resource$/u.test(resource.name)) {
    refusals.push(`${resource.id} is named "${resource.name}": guren codegen discovers a resource class by a PascalCase name ending in Resource, and plan:status reads its payload from there. Rename it (plan:revise).`)
  }
  if (declared.includes(resource.name)) refusals.push(`${resource.id}: the application already declares a ${resource.name} resource.`)
  return refusals
}

/** The validator file of a step: `make:validator`'s path for the model, so a prior `make:feature` is refused as a file that exists. */
export function validatorFilePath(model: PlanModel): string {
  return `${VALIDATORS_DIR}/${model.name}Validator.ts`
}

export function resourceFilePath(resource: PlanResource): string {
  return `${RESOURCES_DIR}/${resource.name}.ts`
}

export function policyFilePath(policy: PlanPolicy): string {
  return `${POLICIES_DIR}/${policy.name}.ts`
}

/** The provider that registers a policy with the gate, named after it. */
export function policyProviderName(policy: PlanPolicy): string {
  return `${policy.name}Provider`
}

export function providerFilePath(policy: PlanPolicy): string {
  return `${PROVIDERS_DIR}/${policyProviderName(policy)}.ts`
}

/** Types a format rule (`email`, `url`, `uuid`) applies to. */
const FORMATTABLE_TYPES: ReadonlySet<PlanColumn['type']> = new Set(['string', 'text', 'uuid'])
/** Types a `min`/`max` bounds: a string's length, a number's value. */
const BOUNDED_TYPES: ReadonlySet<PlanColumn['type']> = new Set([...FORMATTABLE_TYPES, 'integer', 'number', 'decimal'])
const FORMAT_LEAVES: Record<string, string> = { email: 'z.email()', uri: 'z.url()', uuid: 'z.uuid()' }

/**
 * Leaves `field-readers.ts` reads the planned type off. A `decimal` is a number so its bounds
 * read; the judge never calls a type `decimal` (a string or a number may hold one). `json` is a
 * record, `make:validator`'s own, which the reader's allowlist leaves opaque.
 */
const TYPE_LEAVES: Record<PlanColumn['type'], string> = {
  string: 'z.string()',
  text: 'z.string()',
  integer: 'z.number().int()',
  number: 'z.number()',
  decimal: 'z.number()',
  boolean: 'z.boolean()',
  date: 'z.iso.date()',
  datetime: 'z.iso.datetime()',
  json: 'z.record(z.string(), z.any())',
  uuid: 'z.uuid()',
}

/**
 * A query string or route parameter arrives as text, so a number or boolean there must be
 * parsed from it. The reader leaves `required` unknown on these when a value is required: a
 * coerced number takes `null` as 0, and a `stringbool()` is a pipe.
 */
const TEXT_SOURCED_LEAVES: Partial<Record<PlanColumn['type'], string>> = {
  integer: 'z.coerce.number().int()',
  number: 'z.coerce.number()',
  decimal: 'z.coerce.number()',
  boolean: 'z.stringbool()',
}

/** The validators some action of the plan takes its `query` or `params` from. */
export function textSourcedValidators(plan: PlanDraft): Set<string> {
  return new Set(plan.controllers.flatMap((controller) => controller.actions.flatMap((action) => [action.query, action.params].filter((id): id is string => id !== undefined))))
}

function leafOf(field: PlanValidator['fields'][number], format: string | undefined, textSourced: boolean): string {
  if (format && field.type !== 'uuid') return FORMAT_LEAVES[format]!
  if (textSourced) return TEXT_SOURCED_LEAVES[field.type] ?? TYPE_LEAVES[field.type]
  return TYPE_LEAVES[field.type]
}

/** One field's zod expression, and each planned rule it does not write. */
function validatorField(validator: PlanValidator, field: PlanValidator['fields'][number], textSourced: boolean, unwritten: PlanScaffoldUnwritten[]): string {
  const leave = (rule: string, reason: string): void => {
    unwritten.push({ element: validator.id, detail: `field ${field.name} rule ${rule}`, reason })
  }
  let format: string | undefined
  const bounds: string[] = []
  for (const rule of field.rules) {
    const text = rule.trim()
    const named = FORMAT_RULES[text.toLowerCase()]
    const bound = BOUND_RULE.exec(text)
    if (named) {
      if (!FORMATTABLE_TYPES.has(field.type)) leave(rule, `the ${text} format applies to a string, and the field is planned ${field.type}`)
      else if (field.type === 'uuid' && named !== 'uuid') leave(rule, `a uuid field is already validated as one, and a value has one format`)
      else if (format !== undefined && format !== named) leave(rule, `the field already takes the ${format} format, and a value has one`)
      else format = named
    } else if (bound) {
      if (BOUNDED_TYPES.has(field.type)) bounds.push(`.${bound[1]!.toLowerCase()}(${bound[2]})`)
      else leave(rule, `plan:status reads a bound on a string's length or a number's value, not on a ${field.type}`)
    } else {
      leave(rule, 'plan:status compares only min, max, email, url and uuid, so the rule is prose to implement')
    }
  }
  return `${leafOf(field, format, textSourced)}${bounds.join('')}${field.required ? '' : '.nullable().optional()'}`
}

export function buildPlanValidatorSource(validators: readonly PlanValidator[], textSourced: ReadonlySet<string>, unwritten: PlanScaffoldUnwritten[]): string {
  const exports = validators.map((validator) =>
    zodObjectExport(
      validator.name,
      validator.fields.map((field) => `${quoteObjectKey(field.name)}: ${validatorField(validator, field, textSourced.has(validator.id), unwritten)},`),
    ),
  )
  return [ZOD_IMPORT, ...exports].join('\n')
}

/**
 * A payload field copied off the model's record where the planned type admits every value the
 * column reads back as; a `Date` serialized where it admits a `string`; a JSON column, which
 * reads back as `unknown`, cast to the planned type as `make:feature` casts it. `undefined` otherwise.
 */
function payloadValue(field: PlanResource['fields'][number], column: PlanColumn | undefined, nullable: boolean, dialect: SchemaDialect): string | undefined {
  const planned = unionMembers(field.type)
  if (!column || !planned) return undefined
  const base = COLUMN_RECORD_TYPES[dialect][column.type]
  const access = propertyAccess('this.resource', field.name)
  const admits = (value: string): boolean => planned.includes(value) && (!nullable || planned.includes('null'))
  if (base === 'unknown') {
    if (nullable && !planned.includes('null')) return undefined
    return `${access} as ${field.type}`
  }
  if (admits(base)) return access
  if (base === 'Date' && admits('string')) return nullable ? `${access}?.toISOString() ?? null` : `${access}.toISOString()`
  return undefined
}

function unmappedDeclaration(className: string): string {
  return `// plan:scaffold found no column to copy these fields from as they are planned: map each, then remove this.
function unmapped(field: string): never {
  throw new Error(\`${className}.toArray() does not map \${field} yet\`)
}
`
}

export function buildPlanResourceSource(
  resource: PlanResource,
  model: PlanModel,
  columns: readonly PlanColumn[],
  dialect: SchemaDialect,
  unwritten: PlanScaffoldUnwritten[],
): string {
  const primary = columns.filter((column) => column.primaryKey)
  let stubbed = false
  const values = resource.fields.map((field) => {
    const column = columns.find((candidate) => candidate.name === field.name)
    // A single-column primary key is not null whatever the plan says (`scaffold.ts` writes no `.notNull()` on it).
    const nullable = column !== undefined && column.nullable && !(column.primaryKey && primary.length === 1)
    const value = payloadValue(field, column, nullable, dialect)
    if (value !== undefined) return value
    const reads = column ? `the column ${column.name} reads back as ${COLUMN_RECORD_TYPES[dialect][column.type]}${nullable ? ' | null' : ''}` : `${model.name} has no column ${field.name} this step writes`
    unwritten.push({ element: resource.id, detail: `field ${field.name}`, reason: `${reads}, so toArray() throws on it until it is mapped` })
    stubbed = true
    return `unmapped(${quoteString(field.name)})`
  })
  return buildResourceSource({
    className: resource.name,
    modelName: model.name,
    dataFields: resource.fields.map((field) => `${quoteObjectKey(field.name)}: ${field.type}`),
    toArrayFields: resource.fields.map((field, index) => `${quoteObjectKey(field.name)}: ${values[index]},`),
    ...(stubbed ? { declarations: unmappedDeclaration(resource.name) } : {}),
  })
}

/** Every ability denies until it is written: a stub that allowed would authorize what nobody has implemented. */
export function buildPlanPolicySource(policy: PlanPolicy): string {
  return buildPolicySource({
    className: policy.name,
    abilities: policy.abilities.map((ability) => ({
      comment: `Denied until written. Planned: ${ability.rule.replace(/\s+/gu, ' ').trim()}`,
      signature: `${ability.name}(_user: AuthUser | null)`,
      body: 'return false',
    })),
  })
}

/** The shape of the blog template's `AuthorizationProvider`, one per policy so each is registered and removed alone. */
export function buildPolicyProviderSource(policy: PlanPolicy, model: PlanModel): string {
  return `import { ServiceProvider } from '@guren/core'
import { ${model.name} } from '../Models/${model.name}.js'
import { ${policy.name} } from '../Policies/${policy.name}.js'

/** Registers ${policy.name} with the gate for ${model.name} records. */
export default class ${policyProviderName(policy)} extends ServiceProvider {
  register(): void {}

  // The framework's own provider binds the gate during registration, so this
  // runs in boot(): make('gate') throws before that.
  boot(): void {
    this.container.make('gate').policy(${model.name}, ${policy.name})
  }
}
`
}
