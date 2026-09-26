/**
 * The plan-driven scaffold (RFC 0030 §5): a pure function from a scaffold step, and what the
 * application declares, to what `guren plan:scaffold` writes: tables and models here, validators,
 * resources and policies through `scaffold-http.ts`, controllers, routes and side effects through
 * `scaffold-controller.ts`. Every planned property is written in a form the `plan:status` readers
 * (`plan/status.ts`) read back, or listed as unwritten; a property no reader sees stays `unknown`
 * there, and the output is not bent around it. No pages, no action bodies, nothing the plan does not state.
 */

import { MODELS_DIR } from '../discovery'
import { schemaIdentifierFor } from '../inflect'
import { buildModelSource, type ModelRelationshipSource } from '../make-model'
import { autoIncrementPrimaryKey, COLUMN_BUILDERS, MYSQL_UNINDEXABLE_TYPES, quoteString, TABLE_FACTORY, type ColumnCode } from '../schema-columns'
import type { SchemaDialect } from '../schema-parser'
import { isBindingName, isIdentifier, pascalCase, propertyAccess, quoteObjectKey } from '../utils'
import {
  buildPlanPolicySource,
  buildPlanResourceSource,
  buildPlanValidatorSource,
  buildPolicyProviderSource,
  httpLeftReasons,
  policyFilePath,
  policyProviderName,
  policyRefusals,
  providerFilePath,
  resourceFilePath,
  resourceRefusals,
  textSourcedValidators,
  validatorFilePath,
  type PlanScaffoldAdded,
  type PlanScaffoldUnwritten,
} from './scaffold-http'
import {
  buildPlanSideEffectSource,
  controllerFilePath,
  controllerRefusals,
  PlanHttpEmitter,
  scaffoldRoutesFile,
  sideEffectFilePath,
  sideEffectRefusals,
  type PlanScaffoldSymbols,
} from './scaffold-controller'
import {
  listPlanElements,
  type PlanAction,
  type PlanColumn,
  type PlanController,
  type PlanDraft,
  type PlanElementSection,
  type PlanModel,
  type PlanPolicy,
  type PlanResource,
  type PlanRoute,
  type PlanSideEffect,
  type PlanValidator,
} from './schema'
import { hasReference, planRelationshipKeys, type ReferencingColumn } from './relationship-keys'
import type { PlanDerivedStep, PlanTaskDerivation } from './tasks'

export interface PlanScaffoldApp {
  dialect: SchemaDialect
  /** Every app root's tables; `module` is null for the root's. */
  tables: ReadonlyArray<{ identifier: string; tableName?: string; module: string | null; columns: readonly string[]; opaqueColumns?: boolean }>
  /** The model classes the application root declares. */
  models: readonly string[]
  /** The names the root's validator files export. */
  validators: readonly string[]
  /** The resource and policy classes the root declares, by file name as discovery names them. */
  resources: readonly string[]
  policies: readonly string[]
  /** The controller classes the root declares, and its side-effect classes per kind, by file name. */
  controllers: readonly string[]
  sideEffects: Partial<Record<PlanSideEffect['kind'], readonly string[]>>
  /** App-relative files declaring a root model class or exporting a root validator, by name: what a controller or routes file imports. */
  modelFiles: Readonly<Record<string, string>>
  validatorFiles: Readonly<Record<string, string>>
  /** Entity documents that exist (`docs/entities/<Name>.md`), which a `@docs` tag may name without failing `guren check`. */
  docs: readonly string[]
}

export interface PlanScaffoldTable {
  model: string
  identifier: string
  /** The export, as `appendTableToSchema()` appends it. */
  block: string
  /** Builder names the block calls, imported from the dialect's barrel. */
  imports: string[]
}

export interface PlanScaffoldFile {
  /** The plan elements the file writes. */
  elements: string[]
  /** App-relative, POSIX separators. */
  path: string
  contents: string
}

export interface PlanScaffoldOutput {
  tables: PlanScaffoldTable[]
  files: PlanScaffoldFile[]
  /** Element ids written, in document order. */
  emitted: string[]
  /** The step's `generates` this emitter does not write, with why where more than its section says it. */
  left: Array<{ id: string; section: PlanElementSection; reason?: string }>
  /** Planned relationships not written, with why: the agent adds each in a later step. */
  omitted: Array<{ model: string; relationship: string; reason: string }>
  /** Validator rules written in no form a reader compares, and resource fields written as a stub. */
  unwritten: PlanScaffoldUnwritten[]
  /** Providers written under `app/Providers/`, each for the command to register in `createApp()`. */
  providers: string[]
  /** Why nothing may be written. Non-empty means the output is not to be used. */
  refusals: string[]
}

interface TableRef {
  identifier: string
  columns: readonly string[]
  /** Set where a spread or a computed key hides columns, so an absent one is no evidence. */
  opaqueColumns?: boolean
}

function hasColumn(table: TableRef, name: string): boolean {
  return table.opaqueColumns === true || table.columns.includes(name)
}

function sqlNameOf(column: PlanColumn): string {
  return column.columnName ?? column.name
}

function tableAccess(name: string): string {
  return propertyAccess('table', name)
}

function escapeTemplate(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')
}

function sqlDefault(text: string): ColumnCode {
  return { code: `.default(sql\`${escapeTemplate(text)}\`)`, imports: ['sql'] }
}

/** `'draft'`, `"draft"`, or JSON text; anything else is an SQL expression. */
function parseLiteral(text: string): { value: unknown } | undefined {
  const quoted = /^'(.*)'$/s.exec(text) ?? /^"(.*)"$/s.exec(text)
  if (quoted) return { value: quoted[1] }
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

const STRING_TYPES: ReadonlySet<PlanColumn['type']> = new Set(['string', 'text', 'uuid', 'date', 'decimal'])

/**
 * The plan's default as the column's TypeScript type takes it: drizzle reads a `numeric` as a
 * string, so `0` on a decimal is `'0'`. A literal the type cannot hold is written as SQL.
 */
function literalDefault(value: unknown, type: PlanColumn['type']): string | undefined {
  if (type === 'json') return JSON.stringify(value)
  if (STRING_TYPES.has(type)) return typeof value === 'object' ? undefined : quoteString(String(value))
  if (type === 'integer' || type === 'number') return typeof value === 'number' ? String(value) : undefined
  if (type === 'boolean') return typeof value === 'boolean' ? String(value) : undefined
  return undefined
}

/**
 * `now()` on a date or datetime is the dialect's own: pg's `defaultNow()`; MySQL's
 * `CURRENT_TIMESTAMP`, which `plan/status.ts` normalizes to `now()` where drizzle's MySQL
 * `defaultNow()` renders `(now())`, which it compares as text only.
 */
function nowDefault(dialect: SchemaDialect, type: PlanColumn['type']): ColumnCode {
  if (dialect === 'pg') return { code: '.defaultNow()', imports: [] }
  if (dialect === 'mysql') return sqlDefault(type === 'date' ? '(CURRENT_DATE)' : 'CURRENT_TIMESTAMP')
  return sqlDefault(type === 'date' ? "(date('now'))" : '(unixepoch())')
}

function isNullDefault(text: string): boolean {
  return /^null$/i.test(text.trim())
}

function defaultModifier(column: PlanColumn, text: string, dialect: SchemaDialect): ColumnCode {
  const trimmed = text.trim()
  if ((column.type === 'date' || column.type === 'datetime') && /^(now\(\)|current_timestamp(\(\))?)$/i.test(trimmed)) {
    return nowDefault(dialect, column.type)
  }
  const literal = parseLiteral(trimmed)
  const written = literal ? literalDefault(literal.value, column.type) : undefined
  return written === undefined ? sqlDefault(trimmed) : { code: `.default(${written})`, imports: [] }
}

/** A column added to an existing table is an `alter`, which no scaffold writes (§5). */
function scaffoldedModels(plan: PlanDraft, generates: ReadonlySet<string>): PlanModel[] {
  return plan.models.filter((model) => generates.has(model.id) && model.change.kind === 'add')
}

function scaffoldedColumns(model: PlanModel, generates: ReadonlySet<string>): PlanColumn[] {
  return model.columns.filter((column) => column.change.kind === 'add' && generates.has(column.id))
}

function indexName(table: string, columns: readonly string[], unique: boolean): string {
  return `${table}_${columns.join('_')}_${unique ? 'unique' : 'index'}`
}

class Emitter {
  private readonly modelsById: Map<string, PlanModel>
  private readonly emittedModels: Map<string, PlanModel>
  private readonly generates: Set<string>
  readonly refusals: string[] = []
  readonly omitted: PlanScaffoldOutput['omitted'] = []
  readonly unwritten: PlanScaffoldUnwritten[] = []

  constructor(
    private readonly plan: PlanDraft,
    generates: Set<string>,
    models: readonly PlanModel[],
    private readonly app: PlanScaffoldApp,
  ) {
    this.modelsById = new Map(plan.models.map((model) => [model.id, model]))
    this.generates = generates
    this.emittedModels = new Map(models.map((model) => [model.id, model]))
  }

  get models(): PlanModel[] {
    return [...this.emittedModels.values()]
  }

  columnsOf(model: PlanModel): PlanColumn[] {
    return scaffoldedColumns(model, this.generates)
  }

  /** The table a model binds after this run: the one emitted, or the root schema's by SQL name. */
  tableOf(model: PlanModel): TableRef | undefined {
    if (this.emittedModels.has(model.id)) {
      return { identifier: schemaIdentifierFor(model.name), columns: this.columnsOf(model).map((column) => column.name) }
    }
    const root = this.app.tables.filter((table) => table.module === null)
    return (
      root.find((table) => table.tableName === model.table) ?? root.find((table) => table.tableName === undefined && table.identifier === model.table)
    )
  }

  /** A model the root declares after this run, which a lazy import can then load. */
  classExists(model: PlanModel): boolean {
    return this.emittedModels.has(model.id) || this.app.models.includes(model.name)
  }

  checkCollisions(model: PlanModel): void {
    const identifier = schemaIdentifierFor(model.name)
    this.refuseModule(model)
    if (!isIdentifier(model.name) || pascalCase(model.name) !== model.name) {
      this.refusals.push(`${model.id} is named "${model.name}", which is not a PascalCase class name a model file can be named after.`)
    }
    if (this.app.models.includes(model.name)) this.refusals.push(`${model.id}: the application already declares a ${model.name} model.`)
    if (this.app.tables.some((table) => table.module === null && table.identifier === identifier)) {
      this.refusals.push(`${model.id}: db/schema.ts already exports ${identifier}.`)
    }
    const named = this.app.tables.find((table) => (table.tableName ?? table.identifier) === model.table)
    if (named) this.refusals.push(`${model.id}: ${named.module ? `modules/${named.module}/db/schema.ts` : 'db/schema.ts'} already declares the table ${model.table}.`)
  }

  /** What the dialect or the plan's own values would make a table that does not compile or migrate. */
  checkColumns(model: PlanModel): void {
    const columns = this.columnsOf(model)
    for (const column of columns) {
      if (column.default !== undefined && isNullDefault(column.default)) {
        this.refusals.push(`${column.id} plans default ${column.default}: a column without a default is already null when nullable. Drop \`default\` from the plan (plan:revise).`)
      }
    }
    if (this.app.dialect !== 'mysql') return
    const unindexable = (name: string): PlanColumn | undefined => {
      const column = columns.find((candidate) => candidate.name === name)
      return column && MYSQL_UNINDEXABLE_TYPES.has(column.type) ? column : undefined
    }
    const fix = 'MySQL indexes a TEXT or JSON column only by a prefix length drizzle does not write, so drizzle-kit refuses the key and MySQL rejects it (ER_BLOB_KEY_WITHOUT_LENGTH, ER_JSON_USED_AS_KEY). Plan the column as `string` (varchar(255)), or drop the key (plan:revise).'
    for (const column of columns) {
      // A foreign key is keyed too: MySQL creates an index for it.
      const keys = [column.primaryKey && 'primary key', column.unique && 'unique', column.index && 'index', column.references && 'foreign key'].filter(Boolean)
      if (keys.length > 0 && MYSQL_UNINDEXABLE_TYPES.has(column.type)) this.refusals.push(`${column.id} is a ${column.type} column planned ${keys.join(' and ')}. ${fix}`)
    }
    for (const index of model.indexes) {
      const named = index.columns.flatMap((name) => unindexable(name) ?? [])
      if (named.length > 0) this.refusals.push(`${model.id}'s index (${index.columns.join(', ')}) covers the ${named.map((column) => `${column.type} column ${column.name}`).join(' and ')}. ${fix}`)
    }
  }

  /** `undefined` with a refusal recorded when the target is not one this run can point at. */
  private referenceTarget(model: PlanModel, column: ReferencingColumn): { model: PlanModel; table: TableRef } | undefined {
    const reference = column.references
    const target = this.modelsById.get(reference.model)
    const where = `${model.id}.${column.name} references ${reference.model}.${reference.column}`
    if (!target) {
      this.refusals.push(`${where}, which the plan does not declare.`)
      return undefined
    }
    if (target.module) {
      this.refusals.push(`${where}, which sits in module "${target.module}": plan:scaffold writes to the project root only.`)
      return undefined
    }
    const table = this.tableOf(target)
    if (!table) {
      this.refusals.push(`${where}, whose table ${target.table} db/schema.ts does not declare yet. Scaffold or migrate the step that adds it first.`)
      return undefined
    }
    if (!hasColumn(table, reference.column)) {
      this.refusals.push(`${where}, but ${target.table} has no column ${reference.column}.`)
      return undefined
    }
    return { model: target, table }
  }

  table(model: PlanModel): PlanScaffoldTable {
    const { dialect } = this.app
    const identifier = schemaIdentifierFor(model.name)
    const columns = this.columnsOf(model)
    const primary = columns.filter((column) => column.primaryKey)
    const imports = new Set<string>([TABLE_FACTORY[dialect]])
    const extra: string[] = []
    const sqlNames = new Map(model.columns.map((column) => [column.name, sqlNameOf(column)]))

    const lines = columns.map((column) => {
      const single = column.primaryKey === true && primary.length === 1
      const autoIncrement = single && column.type === 'integer' && !column.references
      const parts: ColumnCode[] = [
        autoIncrement ? autoIncrementPrimaryKey(dialect, sqlNameOf(column)) : COLUMN_BUILDERS[dialect][column.type](sqlNameOf(column), column),
      ]
      if (single && !autoIncrement) parts.push({ code: '.primaryKey()', imports: [] })
      if (!column.nullable && !single) parts.push({ code: '.notNull()', imports: [] })
      if (column.unique) parts.push({ code: '.unique()', imports: [] })
      if (column.default !== undefined && !isNullDefault(column.default)) parts.push(defaultModifier(column, column.default, dialect))
      if (hasReference(column)) {
        const target = this.referenceTarget(model, column)
        const { onDelete, column: key } = column.references
        if (target && target.model.id === model.id) {
          // A column cannot reference its own table in its initializer (TS7022), so the key goes to the extra config.
          imports.add('foreignKey')
          extra.push(`foreignKey({ columns: [${tableAccess(column.name)}], foreignColumns: [${tableAccess(key)}] })${onDelete ? `.onDelete('${onDelete}')` : ''}`)
        } else if (target) {
          const options = onDelete ? `, { onDelete: '${onDelete}' }` : ''
          parts.push({ code: `.references(() => ${target.table.identifier}.${key}${options})`, imports: [] })
        }
      }
      for (const part of parts) for (const name of part.imports) imports.add(name)
      if (column.index) {
        imports.add('index')
        extra.push(`index(${quoteString(indexName(model.table, [sqlNameOf(column)], false))}).on(${tableAccess(column.name)})`)
      }
      return `  ${quoteObjectKey(column.name)}: ${parts.map((part) => part.code).join('')},`
    })

    if (primary.length > 1) {
      imports.add('primaryKey')
      extra.push(`primaryKey({ columns: [${primary.map((column) => tableAccess(column.name)).join(', ')}] })`)
    }
    for (const index of model.indexes) {
      const builder = index.unique ? 'uniqueIndex' : 'index'
      imports.add(builder)
      const names = index.columns.map((name) => sqlNames.get(name) ?? name)
      extra.push(`${builder}(${quoteString(indexName(model.table, names, index.unique))}).on(${index.columns.map(tableAccess).join(', ')})`)
    }

    const close = extra.length === 0 ? '})' : `}, (table) => [\n${extra.map((entry) => `  ${entry},`).join('\n')}\n])`
    const block = `export const ${identifier} = ${TABLE_FACTORY[dialect]}(${quoteString(model.table)}, {\n${lines.join('\n')}\n${close}\n`
    return { model: model.id, identifier, block, imports: [...imports].sort() }
  }

  /** The keys a relationship's call takes, from the foreign keys the plan states (`planRelationshipKeys()`). */
  private relationship(model: PlanModel, planned: PlanModel['relationships'][number], declared: { imports: Set<string>; types: Map<string, string> }): ModelRelationshipSource | string {
    const target = this.modelsById.get(planned.target)
    if (!target) return `the plan declares no ${planned.target}`
    if (!this.classExists(target)) return `the application has no ${target.name} model yet`
    const targetTable = this.tableOf(target)
    if (!targetTable) return `db/schema.ts does not declare ${target.table} yet`
    const ownColumns = this.columnsOf(model).map((column) => column.name)
    const keys = planRelationshipKeys(this.plan, model, planned, target, new Set(ownColumns))
    if (typeof keys === 'string') return keys

    let args: string[]
    if (keys.type === 'belongsTo') {
      const owner = keys.key.references.column
      if (!hasColumn(targetTable, owner)) return `${target.table} has no column ${owner}`
      args = [keys.key.name, owner].map(quoteString)
    } else if (keys.type === 'belongsToMany') {
      const { pivot, own, other } = keys
      const pivotTable = this.tableOf(pivot)
      if (!pivotTable || !hasColumn(pivotTable, own.name) || !hasColumn(pivotTable, other.name)) return `the pivot table ${pivot.table} is not declared with both keys yet`
      declared.imports.add(pivotTable.identifier)
      args = [pivotTable.identifier, ...[own.name, other.name, own.references.column, other.references.column].map(quoteString)]
    } else {
      const { key } = keys
      if (!hasColumn(targetTable, key.name)) return `${target.table} has no column ${key.name} yet`
      const local = key.references.column
      if (!ownColumns.includes(local)) return `${model.name} has no column ${local}`
      args = [key.name, local].map(quoteString)
    }

    const recordType = `${target.name}Record`
    if (target.id !== model.id && !declared.types.has(recordType)) {
      declared.types.set(recordType, `type ${recordType} = typeof ${targetTable.identifier}.$inferSelect`)
      declared.imports.add(targetTable.identifier)
    }
    return { name: planned.name, type: planned.type, relatedClass: target.name, args }
  }

  file(model: PlanModel): PlanScaffoldFile {
    const declared = { imports: new Set<string>(), types: new Map<string, string>() }
    const relationships: ModelRelationshipSource[] = []
    for (const planned of model.relationships) {
      const target = this.modelsById.get(planned.target)
      if (target?.module) {
        this.refusals.push(`${model.id}'s relationship ${planned.name} targets ${target.id}, which sits in module "${target.module}": plan:scaffold writes to the project root only.`)
        continue
      }
      const written = this.relationship(model, planned, declared)
      if (typeof written === 'string') this.omitted.push({ model: model.id, relationship: planned.name, reason: written })
      else relationships.push(written)
    }
    const contents = buildModelSource({
      className: model.name,
      schemaIdentifier: schemaIdentifierFor(model.name),
      fillable: model.fillable,
      relationships,
      schemaImports: [...declared.imports],
      typeDeclarations: [...declared.types.values()],
    })
    return { elements: [model.id], path: `${MODELS_DIR}/${model.name}.ts`, contents }
  }

  private refuseModule(element: { id: string; module?: string }): void {
    if (element.module) this.refusals.push(`${element.id} sits in module "${element.module}": plan:scaffold writes to the project root only.`)
  }

  /**
   * One file named after the step's model: a step adding two models could name it after either, so it is refused.
   * `planScaffoldCoverage()` would still list those validators as written; unreachable while derivation gives each added model its own task.
   */
  validators(validators: readonly PlanValidator[]): PlanScaffoldFile[] {
    const [model, ...others] = this.models
    if (!model || validators.length === 0) return []
    if (others.length > 0) {
      this.refusals.push(
        `${validators.map((validator) => validator.id).join(', ')}: the step adds ${this.models.map((added) => added.id).join(' and ')}, and the validator file is named after one model. Write the validators by hand in the http step, or split the models across tasks (plan:revise).`,
      )
    }
    const names = new Set<string>()
    for (const validator of validators) {
      this.refuseModule(validator)
      if (!isBindingName(validator.name)) this.refusals.push(`${validator.id} is named "${validator.name}", which an exported const cannot be named.`)
      if (this.app.validators.includes(validator.name)) this.refusals.push(`${validator.id}: a validator file already exports ${validator.name}.`)
      if (names.has(validator.name)) this.refusals.push(`${validator.id}: another validator of the step is named ${validator.name}.`)
      names.add(validator.name)
    }
    const contents = buildPlanValidatorSource(validators, textSourcedValidators(this.plan), this.unwritten)
    return [{ elements: validators.map((validator) => validator.id), path: validatorFilePath(model), contents }]
  }

  resource(resource: PlanResource): PlanScaffoldFile {
    this.refuseModule(resource)
    this.refusals.push(...resourceRefusals(resource, this.app.resources))
    const model = this.emittedModels.get(resource.model)!
    const contents = buildPlanResourceSource(resource, model, this.columnsOf(model), this.app.dialect, this.unwritten)
    return { elements: [resource.id], path: resourceFilePath(resource), contents }
  }

  policy(policy: PlanPolicy): PlanScaffoldFile[] {
    this.refuseModule(policy)
    this.refusals.push(...policyRefusals(policy, this.app.policies))
    const model = this.emittedModels.get(policy.model)!
    return [
      { elements: [policy.id], path: policyFilePath(policy), contents: buildPlanPolicySource(policy) },
      { elements: [policy.id], path: providerFilePath(policy), contents: buildPolicyProviderSource(policy, model) },
    ]
  }

  /** What a controller or routes file may import after this run: the root's classes and schemas, and what the run writes. */
  private symbols(validators: readonly PlanValidator[]): PlanScaffoldSymbols {
    const models = new Map(Object.entries(this.app.modelFiles))
    for (const model of this.models) models.set(model.name, `${MODELS_DIR}/${model.name}.ts`)
    const schemas = new Map(Object.entries(this.app.validatorFiles))
    const [model] = this.models
    if (model) for (const validator of validators) schemas.set(validator.name, validatorFilePath(model))
    return { models, validators: schemas, docs: new Set(this.app.docs) }
  }

  /** The controllers, and one routes file named after the model the step adds, as the validator file is. */
  http(selection: Selection): PlanScaffoldFile[] {
    const [model, ...others] = this.models
    if (!model || (selection.controllers.length === 0 && selection.routes.length === 0)) return []
    const emitter = new PlanHttpEmitter(this.plan, this.symbols(selection.validators), this.unwritten)
    const files: PlanScaffoldFile[] = selection.controllers.map(({ controller, actions }) => {
      this.refuseModule(controller)
      this.refusals.push(...controllerRefusals(controller, actions, this.app.controllers))
      return { elements: [controller.id, ...actions.map((action) => action.id)], path: controllerFilePath(controller), contents: emitter.controller(controller, actions, model) }
    })
    if (selection.routes.length > 0) {
      if (others.length > 0) {
        this.refusals.push(`${selection.routes.map((route) => route.id).join(', ')}: the step adds ${this.models.map((added) => added.id).join(' and ')}, and the routes file is named after one model. Split the models across tasks (plan:revise).`)
      }
      files.push({ elements: selection.routes.map((route) => route.id), path: scaffoldRoutesFile(model).path, contents: emitter.routes(model, selection.routes) })
    }
    return files
  }

  sideEffect(effect: PlanSideEffect): PlanScaffoldFile {
    this.refuseModule(effect)
    this.refusals.push(...sideEffectRefusals(effect, this.app.sideEffects[effect.kind] ?? []))
    return { elements: [effect.id], path: sideEffectFilePath(effect), contents: buildPlanSideEffectSource(effect) }
  }

  /** Two elements writing one file (two side effects of a kind by one name) would have the second write refused half way. */
  checkPaths(files: readonly PlanScaffoldFile[]): void {
    const seen = new Map<string, string[]>()
    for (const file of files) {
      const earlier = seen.get(file.path)
      if (earlier) this.refusals.push(`${[...earlier, ...file.elements].join(' and ')} would each write ${file.path}.`)
      seen.set(file.path, [...(earlier ?? []), ...file.elements])
    }
  }
}

/** The command `plan:next` names for a scaffold step. */
export function planScaffoldCommandLine(planArgument: string, stepId: string): string {
  return `bunx guren plan:scaffold ${planArgument} --step ${stepId}`
}

/** The command `plan:next` and `guren check` name for the http step that mounts a scaffolded routes file. */
export function planScaffoldMountCommandLine(planArgument: string, stepId: string): string {
  return `${planScaffoldCommandLine(planArgument, stepId)} --mount`
}

interface Selection extends PlanScaffoldAdded {
  models: PlanModel[]
  /** Each added controller the step writes, with the added actions it holds. */
  controllers: Array<{ controller: PlanController; actions: PlanAction[] }>
  routes: PlanRoute[]
  sideEffects: PlanSideEffect[]
  /** Why an element of `generates` is left, where there is more to say than its section. */
  reasons: Map<string, string>
}

/**
 * What a step writes, decided from the plan alone: each added model and its added columns; the
 * validators, in a file named after the model; each resource and policy whose model the step
 * adds, since the files import that model and its record type; each added controller with its
 * added actions; the routes to those actions, in one file named after the model; the side effects.
 */
function select(plan: PlanDraft, generates: ReadonlySet<string>): Selection {
  const models = scaffoldedModels(plan, generates)
  const addedIn = <T extends { id: string; change: { kind: string } }>(elements: readonly T[]): T[] =>
    elements.filter((element) => generates.has(element.id) && element.change.kind === 'add')
  const added: PlanScaffoldAdded = { validators: addedIn(plan.validators), resources: addedIn(plan.resources), policies: addedIn(plan.policies) }
  const reasons = httpLeftReasons(added, models)
  const kept = <T extends { id: string }>(elements: T[]): T[] => elements.filter((element) => !reasons.has(element.id))

  const controllers = addedIn(plan.controllers).map((controller) => ({ controller, actions: addedIn(controller.actions) }))
  const written = new Set(controllers.flatMap(({ actions }) => actions.map((action) => action.id)))
  for (const controller of plan.controllers) {
    if (controllers.some((selected) => selected.controller.id === controller.id)) continue
    for (const action of addedIn(controller.actions)) {
      reasons.set(action.id, `its controller ${controller.className} is not one this step adds, and plan:scaffold writes no action into an existing file`)
    }
  }
  const routes = addedIn(plan.routes).filter((route) => {
    if (written.has(route.action)) return true
    reasons.set(route.id, `its action ${route.action} is not one this step writes`)
    return false
  })
  return {
    models,
    validators: kept(added.validators),
    resources: kept(added.resources),
    policies: kept(added.policies),
    controllers,
    routes,
    sideEffects: addedIn(plan.sideEffects),
    reasons,
  }
}

function coverageOf(plan: PlanDraft, generates: ReadonlySet<string>, selection: Selection): Pick<PlanScaffoldOutput, 'emitted' | 'left'> {
  const written = new Set([
    ...selection.models.flatMap((model) => [model.id, ...scaffoldedColumns(model, generates).map((column) => column.id)]),
    ...[...selection.validators, ...selection.resources, ...selection.policies].map((element) => element.id),
    ...selection.controllers.flatMap(({ controller, actions }) => [controller.id, ...actions.map((action) => action.id)]),
    ...[...selection.routes, ...selection.sideEffects].map((element) => element.id),
  ])
  const elements = listPlanElements(plan)
  return {
    emitted: elements.filter((element) => written.has(element.id)).map((element) => element.id),
    left: elements
      .filter((element) => generates.has(element.id) && !written.has(element.id))
      .map((element) => {
        const reason = selection.reasons.get(element.id)
        return reason === undefined ? element : { ...element, reason }
      }),
  }
}

/** Which of a scaffold step's `generates` `plan:scaffold` writes and which it leaves: its report and `plan:next` both say it through here. */
export function planScaffoldCoverage(plan: PlanDraft, step: Pick<PlanDerivedStep, 'generates'>): Pick<PlanScaffoldOutput, 'emitted' | 'left'> {
  const generates = new Set(step.generates)
  return coverageOf(plan, generates, select(plan, generates))
}

/** A routes file a scaffold step writes, and the http step that mounts it: the step, or part, holding those routes. */
export interface PlanScaffoldMount {
  task: string
  scaffoldStep: string
  httpStep: string
  path: string
  registrar: string
  routes: string[]
}

/** Every routes file the plan's scaffold steps write: what `--mount`, `plan:next` and `guren check` read the scaffold's routes by. */
export function planScaffoldMounts(plan: PlanDraft, derivation: PlanTaskDerivation): PlanScaffoldMount[] {
  return derivation.tasks.flatMap((task) => {
    const scaffold = task.steps.find((step) => step.kind === 'scaffold')
    const title = task.title
    const model = title.kind === 'entity' ? plan.models.find((candidate) => candidate.id === title.model) : undefined
    // A module's slice is refused by the scaffold, which writes to the project root only.
    if (!scaffold || !model || model.module) return []
    const routes = select(plan, new Set(scaffold.generates)).routes.map((route) => route.id)
    // Derivation gives every route of a task to one of its http steps.
    const http = task.steps.find((step) => step.kind === 'http' && step.elementIds.some((id) => routes.includes(id)))
    return http ? [{ task: task.id, scaffoldStep: scaffold.id, httpStep: http.id, ...scaffoldRoutesFile(model), routes }] : []
  })
}

const NO_APP: PlanScaffoldApp = { dialect: 'pg', tables: [], models: [], validators: [], resources: [], policies: [], controllers: [], sideEffects: {}, modelFiles: {}, validatorFiles: {}, docs: [] }

/** The files `plan:scaffold` writes for `step`. The plan alone names them: the application changes their contents and the refusals, never which files. */
export function planScaffoldFilePaths(plan: PlanDraft, step: PlanDerivedStep): string[] {
  return emitPlanScaffold(plan, step, NO_APP).files.map((file) => file.path)
}

/** What `plan:scaffold` writes for `step`. Pure: the caller reads the application and writes the result. */
export function emitPlanScaffold(plan: PlanDraft, step: PlanDerivedStep, app: PlanScaffoldApp): PlanScaffoldOutput {
  const generates = new Set(step.generates)
  const selection = select(plan, generates)
  const emitter = new Emitter(plan, generates, selection.models, app)
  for (const model of emitter.models) {
    emitter.checkCollisions(model)
    emitter.checkColumns(model)
  }
  const tables = emitter.models.map((model) => emitter.table(model))
  const files = [
    ...emitter.models.map((model) => emitter.file(model)),
    ...emitter.validators(selection.validators),
    ...selection.resources.map((resource) => emitter.resource(resource)),
    ...selection.policies.flatMap((policy) => emitter.policy(policy)),
    ...emitter.http(selection),
    ...selection.sideEffects.map((effect) => emitter.sideEffect(effect)),
  ]
  emitter.checkPaths(files)
  return {
    tables,
    files,
    ...coverageOf(plan, generates, selection),
    omitted: emitter.omitted,
    unwritten: emitter.unwritten,
    providers: selection.policies.map(policyProviderName),
    refusals: emitter.refusals,
  }
}
