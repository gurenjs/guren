/**
 * The validator, resource and policy half of the plan-driven scaffold (RFC 0030 §5), pure like
 * `scaffold.ts`, which calls it. Each is written in the one shape `plan:status` reads back: a
 * validator field through `field-readers.ts`'s zod allowlist, a resource payload as `guren
 * codegen` copies it, a policy's abilities as methods of a class extending `Policy`.
 */

import { buildPolicySource, POLICY_DIR } from '../make-policy'
import { buildResourceSource } from '../make-resource'
import { VALIDATOR_DIR, ZOD_IMPORT, zodObjectExport } from '../make-validator'
import { RESOURCES_DIR } from '../discovery'
import { parseSourceFile } from '../parse-cache'
import { COLUMN_RECORD_TYPES } from '../schema-columns'
import type { SchemaDialect } from '../schema-parser'
import { isIdentifier, quoteObjectKey } from '../utils'
import { BOUND_RULE, FORMAT_RULES, sameSet, unionMembers } from './field-status'
import type { PlanColumn, PlanDraft, PlanModel, PlanPolicy, PlanResource, PlanValidator } from './schema'

/** A planned property written in no form a reader compares, or as a stub: the http step finishes it. */
export interface PlanScaffoldUnwritten {
  element: string
  detail: string
  reason: string
}

export const PROVIDERS_DIR = 'app/Providers'

/** Why each of a step's `generates` in these sections is left to the http step, where it is not written. */
export function httpLeftReasons(plan: PlanDraft, generates: ReadonlySet<string>, models: readonly PlanModel[]): Map<string, string> {
  const reasons = new Map<string, string>()
  const modelIds = new Set(models.map((model) => model.id))
  const added = <T extends { id: string; change: { kind: string } }>(elements: readonly T[]): T[] =>
    elements.filter((element) => generates.has(element.id) && element.change.kind === 'add')
  if (models.length === 0) {
    for (const validator of added(plan.validators)) reasons.set(validator.id, 'the step adds no model to name its validator file after')
  }
  const onModel = (model: string): string | undefined =>
    modelIds.has(model) ? undefined : `its model ${model} is not one this step adds, so the model's record type is not known to exist`
  for (const resource of added(plan.resources)) {
    const why = onModel(resource.model) ?? resource.fields.map((field) => unwritableType(field.type)).find((reason) => reason !== undefined)
    if (why) reasons.set(resource.id, why)
  }
  for (const policy of added(plan.policies)) {
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
 * the file would have to import (`UserResourceData`), or it does not parse as one type.
 */
function unwritableType(text: string): string | undefined {
  const program = parseSourceFile(`type Planned = ${text}\n`, 'payload.ts')?.program
  const alias = program?.body.length === 1 ? program.body[0] : undefined
  if (alias?.type !== 'TSTypeAliasDeclaration') return `its field type \`${text}\` does not parse as one type`
  const named: string[] = []
  const walk = (node: { type: string; [key: string]: unknown }): boolean => {
    if (TYPE_KEYWORDS.has(node.type)) return true
    if (node.type === 'TSUnionType') return (node.types as Array<typeof node>).every(walk)
    if (node.type === 'TSArrayType') return walk(node.elementType as typeof node)
    if (node.type === 'TSParenthesizedType') return walk(node.typeAnnotation as typeof node)
    if (node.type === 'TSTypeReference') {
      const name = node.typeName as { type: string; name?: string }
      const params = (node.typeParameters as { params: Array<typeof node> } | undefined)?.params ?? []
      if (name.type === 'Identifier' && GLOBAL_TYPES.has(name.name!)) return params.every(walk)
      named.push(name.name ?? 'a qualified name')
      return false
    }
    named.push(`a ${node.type.replace(/^TS/u, '')}`)
    return false
  }
  if (walk(alias.typeAnnotation as unknown as { type: string })) return undefined
  return `its field type \`${text}\` names ${named[0]}, which the resource file would have to import`
}

/** Class and file names a JS reserved word cannot take: `export const delete = …` does not parse. */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'yield',
])

export function isBindingName(name: string): boolean {
  return isIdentifier(name) && !RESERVED_WORDS.has(name)
}

/** `Policy`'s own members: an ability of one of these names replaces the hook or the helper. */
const POLICY_MEMBERS = new Set(['constructor', 'before', 'allow', 'deny', 'denyWithStatus', 'denyAsNotFound'])

export function policyRefusals(policy: PlanPolicy, declared: readonly string[]): string[] {
  const refusals: string[] = []
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
  return `${VALIDATOR_DIR}/${model.name}Validator.ts`
}

const STRING_TYPES: ReadonlySet<PlanColumn['type']> = new Set(['string', 'text', 'uuid'])
const BOUNDED_TYPES: ReadonlySet<PlanColumn['type']> = new Set(['string', 'text', 'uuid', 'integer', 'number', 'decimal'])
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
      if (!STRING_TYPES.has(field.type)) leave(rule, `the ${text} format applies to a string, and the field is planned ${field.type}`)
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
  const leaf = format && field.type !== 'uuid' ? FORMAT_LEAVES[format]! : ((textSourced ? TEXT_SOURCED_LEAVES[field.type] : undefined) ?? TYPE_LEAVES[field.type])
  return `${leaf}${bounds.join('')}${field.required ? '' : '.nullable().optional()'}`
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

function member(object: string, name: string): string {
  return isIdentifier(name) ? `${object}.${name}` : `${object}[${quoteObjectKey(name)}]`
}

/**
 * A payload field copied off the model's record where the column's record type is the planned
 * one, or a `Date` column serialized to the planned `string`; `undefined` where it is neither.
 */
function payloadValue(field: PlanResource['fields'][number], column: PlanColumn | undefined, nullable: boolean, dialect: SchemaDialect): string | undefined {
  const planned = unionMembers(field.type)
  if (!column || !planned) return undefined
  const base = COLUMN_RECORD_TYPES[dialect][column.type]
  const access = member('this.resource', field.name)
  if (sameSet(planned, nullable ? [base, 'null'] : [base])) return access
  if (base === 'Date' && sameSet(planned, nullable ? ['string', 'null'] : ['string'])) return nullable ? `${access}?.toISOString() ?? null` : `${access}.toISOString()`
  return undefined
}

export function buildPlanResourceSource(
  resource: PlanResource,
  model: PlanModel,
  columns: readonly PlanColumn[],
  dialect: SchemaDialect,
  unwritten: PlanScaffoldUnwritten[],
): string {
  const primary = columns.filter((column) => column.primaryKey)
  const values = resource.fields.map((field) => {
    const column = columns.find((candidate) => candidate.name === field.name)
    // A single-column primary key is not null whatever the plan says (`scaffold.ts` writes no `.notNull()` on it).
    const nullable = column !== undefined && column.nullable && !(column.primaryKey && primary.length === 1)
    const value = payloadValue(field, column, nullable, dialect)
    if (value !== undefined) return value
    const reads = column ? `the column ${column.name} reads back as ${COLUMN_RECORD_TYPES[dialect][column.type]}${nullable ? ' | null' : ''}` : `${model.name} has no column ${field.name} this step writes`
    unwritten.push({ element: resource.id, detail: `field ${field.name}`, reason: `${reads}, so toArray() throws on it until it is mapped` })
    return `unmapped('${field.name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}')`
  })
  const stubbed = values.some((value) => value.startsWith('unmapped('))
  return buildResourceSource({
    className: resource.name,
    modelName: model.name,
    dataFields: resource.fields.map((field) => `${quoteObjectKey(field.name)}: ${field.type}`),
    toArrayFields: resource.fields.map((field, index) => `${quoteObjectKey(field.name)}: ${values[index]},`),
    ...(stubbed
      ? {
          declarations: `// plan:scaffold found no column to copy these fields from as they are planned: map each, then remove this.
function unmapped(field: string): never {
  throw new Error(\`${resource.name}.toArray() does not map \${field} yet\`)
}
`,
        }
      : {}),
  })
}

export function resourceFilePath(resource: PlanResource): string {
  return `${RESOURCES_DIR}/${resource.name}.ts`
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

export function policyFilePath(policy: PlanPolicy): string {
  return `${POLICY_DIR}/${policy.name}.ts`
}

/** The provider that registers a policy with the gate, named after it. */
export function policyProviderName(policy: PlanPolicy): string {
  return `${policy.name}Provider`
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
