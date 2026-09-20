/**
 * The status of a plan against the code (RFC 0030 §6), as one pure function of the plan
 * and the application state. It reads no file and runs nothing: `verified` and `waived`
 * belong to `plan:verify` and `plan:waive`, which upgrade a result from here.
 * A planned property is compared only as finely as its reader reads it. One with no
 * reader is `unknown`, which never counts towards `present` and never satisfies a `drop`.
 */

import type { SchemaColumnDefault, SchemaConstraint } from '../schema-parser'
import type { RuntimeSchemaColumn, SourcedSchemaTable } from '../schema-runtime'
import type {
  PlanAppActionDetail,
  PlanAppDetail,
  PlanAppMount,
  PlanAppRouteDetail,
  PlanAppSideEffectKind,
} from './app-detail'
import { isUnreadable, type PlanAppNames, type PlanAppState, type PlanAppUnreadable } from './app-state'
import type {
  PlanAction,
  PlanChange,
  PlanColumn,
  PlanController,
  PlanDraft,
  PlanElementSection,
  PlanModel,
  PlanRoute,
  PlanView,
} from './schema'

/** Every state of RFC 0030 §6. `plan:status` sets the ones in {@link PlanStatusState}. */
export type PlanElementState = 'planned' | 'present' | 'wired' | 'verified' | 'drifted' | 'unjudged' | 'blocked' | 'waived'

export type PlanStatusState = Exclude<PlanElementState, 'verified' | 'waived'>

export const PLAN_STATUS_STATES = ['planned', 'present', 'wired', 'drifted', 'unjudged', 'blocked'] as const satisfies readonly PlanStatusState[]

export type PlanPropertyVerdict = 'match' | 'differ' | 'unknown'

export interface PlanPropertyStatus {
  property: string
  verdict: PlanPropertyVerdict
  planned?: string
  /** What the reader found, on `match` and `differ`. */
  actual?: string
  /** Why the property could not be compared, on `unknown`. */
  reason?: string
}

/** `S` widens to {@link PlanElementState} for the result `plan:verify` layers on this one. */
export interface PlanElementStatus<S extends PlanElementState = PlanStatusState> {
  id: string
  section: PlanElementSection
  change: PlanChange['kind']
  /** The name the element has in code, e.g. `Comment`, `comments.postId`, `comments.store`. */
  label: string
  state: S
  /** Why, on `blocked` and `unjudged`. */
  reason?: string
  properties: PlanPropertyStatus[]
  notes: string[]
}

export interface PlanStatusSummary {
  /** Elements the plan changes, per state. `existing` elements are counted apart. */
  states: Record<PlanStatusState, number>
  /** `unread` holds the ones whose section could not be read, which are neither found nor missing. */
  existing: { found: number; missing: string[]; unread: string[] }
  properties: Record<PlanPropertyVerdict, number>
  /** Planned, not checkable: the `unknown` properties of each element, by id. */
  notCheckable: Array<{ id: string; properties: string[] }>
}

export interface PlanStatus<S extends PlanElementState = PlanStatusState> {
  elements: PlanElementStatus<S>[]
  summary: PlanStatusSummary
}

/** Sections `plan:status` judges. Flows, tasks, behaviours and questions describe work, not code. */
export const PLAN_STATUS_SECTIONS = [
  'models',
  'columns',
  'validators',
  'controllers',
  'actions',
  'routes',
  'views',
  'resources',
  'policies',
  'sideEffects',
  'commands',
] as const satisfies readonly PlanElementSection[]

type Existence = 'yes' | 'no' | { unknown: string }

interface Judgement {
  id: string
  section: PlanElementSection
  change: PlanChange
  label: string
  exists: Existence
  /** `rename` only: whether the previous name is still in the code. */
  previous?: Existence
  /** Compared only once the element exists. */
  properties?: () => PlanPropertyStatus[]
  /** Asked only of an element that is `present`; absent for a kind with no mount point. */
  mount?: () => PlanAppMount
  /** No reader exists for this kind of element at all. */
  unjudged?: string
  notes?: string[]
}

const match = (property: string, planned: string, actual = planned): PlanPropertyStatus => ({ property, verdict: 'match', planned, actual })
const differ = (property: string, planned: string, actual: string): PlanPropertyStatus => ({ property, verdict: 'differ', planned, actual })
const unknown = (property: string, planned: string, reason: string): PlanPropertyStatus => ({ property, verdict: 'unknown', planned, reason })

function compare(property: string, planned: string, actual: string | undefined, whyUnknown: string): PlanPropertyStatus {
  if (actual === undefined) return unknown(property, planned, whyUnknown)
  return actual === planned ? match(property, planned) : differ(property, planned, actual)
}

function conclude(judgement: Judgement): PlanElementStatus {
  const { id, section, change, label } = judgement
  const base = { id, section, change: change.kind, label }
  const notes = [...(judgement.notes ?? [])]
  const done = (state: PlanStatusState, extra: Partial<PlanElementStatus> = {}): PlanElementStatus => ({
    ...base,
    state,
    properties: [],
    notes,
    ...extra,
  })

  if (judgement.unjudged) return done('unjudged', { reason: judgement.unjudged })
  const { exists } = judgement
  if (typeof exists === 'object') return done('blocked', { reason: exists.unknown })

  if (change.kind === 'drop') return done(exists === 'yes' ? 'planned' : 'present')
  if (change.kind === 'existing') {
    if (exists === 'no') notes.push('The plan references this as existing, and it was not found.')
    return done(exists === 'yes' ? 'present' : 'planned')
  }

  if (exists === 'no') {
    if (change.kind === 'alter') notes.push('The element this alters was not found.')
    if (change.kind === 'rename' && judgement.previous === 'no') notes.push(`Neither "${change.from}" nor the new name was found.`)
    return done('planned')
  }

  const properties = judgement.properties?.() ?? []
  if (change.kind === 'rename') {
    const previous = judgement.previous ?? { unknown: 'the previous name has no reader' }
    properties.unshift(
      typeof previous === 'object'
        ? unknown('previous name removed', change.from, previous.unknown)
        : previous === 'no'
          ? match('previous name removed', change.from, 'absent')
          : differ('previous name removed', change.from, 'still present'),
    )
  }

  const readable = properties.filter((property) => property.verdict !== 'unknown')
  const differing = readable.filter((property) => property.verdict === 'differ')
  const result = (state: PlanStatusState, extra: Partial<PlanElementStatus> = {}): PlanElementStatus =>
    done(state, { properties, ...extra })

  // An alter's target existed before the plan, so its existence says nothing about the change.
  if (change.kind === 'alter' && readable.length === 0) {
    return result('unjudged', { reason: 'No planned property of this change has a reader.' })
  }
  if (differing.length > 0) {
    const untouched = change.kind === 'alter' && differing.length === readable.length
    return result(untouched ? 'planned' : 'drifted')
  }

  if (!judgement.mount) return result('present')
  const mount = judgement.mount()
  if (mount === 'mounted') return result('wired')
  notes.push(`Not confirmed as wired: ${mount.unconfirmed}.`)
  return result('present')
}

function inSection(section: PlanAppNames, name: string, what: string): Existence {
  if (isUnreadable(section)) return { unknown: `the application's ${what} could not be read (${section.unreadable})` }
  return section.includes(name) ? 'yes' : 'no'
}

/**
 * Narrows a name match to the app root the plan puts the element in: `modules/<name>`,
 * or the project root when the plan states none. `found` is what the scan found under
 * that name, `undefined` meaning no reader says where any of it came from — which is
 * unknown whichever root the plan names, since a match either way would be a guess.
 */
function inScope(
  exists: Existence,
  declared: string | undefined,
  found: ReadonlyArray<{ module: string | null }> | undefined,
  what: string,
): Existence {
  if (exists !== 'yes') return exists
  if (found === undefined) return { unknown: `nothing reads which app root each ${what} sits in` }
  return found.some((entry) => entry.module === (declared ?? null)) ? 'yes' : 'no'
}

/** The entries of a detail section a name matches, or `undefined` when the section could not be read. */
function matching<T>(section: T[] | PlanAppUnreadable | undefined, match: (entry: T) => boolean): T[] | undefined {
  return section === undefined || isUnreadable(section) ? undefined : section.filter(match)
}

function scopeName(module: string | undefined): string {
  return module ? `modules/${module}` : 'the project root'
}

function tableUnread(table: SourcedSchemaTable | PlanAppUnreadable | undefined): table is PlanAppUnreadable {
  return table !== undefined && 'unreadable' in table
}

function previousOf(change: PlanChange, lookup: (name: string) => Existence): Existence | undefined {
  return change.kind === 'rename' ? lookup(change.from) : undefined
}

const NO_DETAIL: PlanAppUnreadable = { unreadable: 'the application state was loaded without detail' }

export function judgePlan(plan: PlanDraft, app: PlanAppState): PlanStatus {
  const context = new StatusContext(plan, app)
  const elements: PlanElementStatus[] = [
    ...plan.models.flatMap((model) => [context.model(model), ...model.columns.map((column) => context.column(model, column))]),
    ...plan.validators.map((validator) => context.validator(validator)),
    ...plan.controllers.flatMap((controller) => [
      context.controller(controller),
      ...controller.actions.map((action) => context.action(controller, action)),
    ]),
    ...plan.routes.map((route) => context.route(route)),
    ...plan.views.map((view) => context.view(view)),
    ...plan.resources.map((resource) => context.named('resources', resource, app.resources, 'resources', resource.fields.length > 0 ? ['fields'] : [])),
    ...plan.policies.map((policy) => context.named('policies', policy, app.policies, 'policies', policy.abilities.length > 0 ? ['abilities'] : [])),
    ...plan.sideEffects.map((effect) => context.sideEffect(effect)),
    ...plan.commands.map((command): PlanElementStatus =>
      conclude({ id: command.id, section: 'commands', change: { kind: 'add' }, label: command.command, exists: 'no', unjudged: 'Nothing reads whether a command has been run.' }),
    ),
  ]
  return { elements, summary: summarize(elements) }
}

export function summarize(elements: ReadonlyArray<PlanElementStatus>): PlanStatusSummary {
  const states = Object.fromEntries(PLAN_STATUS_STATES.map((state) => [state, 0])) as Record<PlanStatusState, number>
  const properties: Record<PlanPropertyVerdict, number> = { match: 0, differ: 0, unknown: 0 }
  const existing = { found: 0, missing: [] as string[], unread: [] as string[] }
  const notCheckable: PlanStatusSummary['notCheckable'] = []

  for (const element of elements) {
    if (element.change === 'existing') {
      if (element.state === 'planned') existing.missing.push(element.id)
      else if (element.state === 'present') existing.found += 1
      else existing.unread.push(element.id)
      continue
    }
    states[element.state] += 1
    for (const property of element.properties) properties[property.verdict] += 1
    const unknowns = element.properties.filter((property) => property.verdict === 'unknown').map((property) => property.property)
    if (unknowns.length > 0) notCheckable.push({ id: element.id, properties: unknowns })
  }
  return { states, existing, properties, notCheckable }
}

const TEXTUAL = ['text', 'varchar', 'char', 'tinytext', 'mediumtext', 'longtext']
const INTEGRAL = ['integer', 'int', 'serial', 'bigint', 'bigserial', 'smallint', 'smallserial', 'mediumint', 'tinyint']

/**
 * The drizzle builders each abstract column type projects onto, and the ones that may
 * carry it under a `mode` option no reader reports (SQLite keeps booleans, dates and
 * JSON in `integer` and `text`). An ambiguous builder is `unknown`, never a match.
 */
const COLUMN_TYPE_BUILDERS: Record<PlanColumn['type'], { accepts: string[]; ambiguous: string[] }> = {
  string: { accepts: TEXTUAL, ambiguous: [] },
  text: { accepts: TEXTUAL, ambiguous: [] },
  integer: { accepts: INTEGRAL, ambiguous: [] },
  number: { accepts: ['real', 'double', 'doublePrecision', 'float', ...INTEGRAL], ambiguous: ['numeric', 'decimal'] },
  decimal: { accepts: ['numeric', 'decimal'], ambiguous: [] },
  boolean: { accepts: ['boolean'], ambiguous: ['integer', 'int', 'tinyint'] },
  date: { accepts: ['date'], ambiguous: ['integer', 'text', 'timestamp', 'datetime'] },
  datetime: { accepts: ['timestamp', 'datetime'], ambiguous: ['integer', 'text'] },
  json: { accepts: ['json', 'jsonb'], ambiguous: ['text'] },
  uuid: { accepts: ['uuid'], ambiguous: [...TEXTUAL, 'binary'] },
}

/** `timestamp with time zone` → `timestamp`, `double precision` → `double`, `numeric(10, 2)` → `numeric`. */
function builderOf(column: RuntimeSchemaColumn): string | undefined {
  if (column.type && !column.opaqueBuilder) return column.type
  return column.sqlType?.toLowerCase().match(/^[a-z]+/)?.[0]
}

function defaultText(value: SchemaColumnDefault): string | undefined {
  if (value.kind === 'now') return 'now()'
  return 'text' in value ? value.text : undefined
}

function normalizeDefault(text: string): string {
  const bare = text.trim().replace(/^(['"`])(.*)\1$/s, '$2').replace(/\s+/g, '').toLowerCase()
  return bare === 'current_timestamp' || bare === 'current_timestamp()' ? 'now()' : bare
}

function sameColumns(constraint: SchemaConstraint, columns: ReadonlyArray<string>): boolean {
  return !constraint.opaqueColumns && constraint.columns.length === columns.length && columns.every((column, index) => constraint.columns[index] === column)
}

/** Whether a table carries an index over exactly `columns`; `undefined` when its constraints are not all visible. */
function hasIndex(table: SourcedSchemaTable, columns: ReadonlyArray<string>, kinds: ReadonlyArray<SchemaConstraint['kind']>): boolean | undefined {
  if (table.constraints.some((constraint) => kinds.includes(constraint.kind) && sameColumns(constraint, columns))) return true
  const hidden = table.opaqueConstraints || table.constraints.some((constraint) => kinds.includes(constraint.kind) && constraint.opaqueColumns)
  return hidden ? undefined : false
}

const CONSTRAINTS_HIDDEN = "the table's constraints are built where the static reader cannot follow"

class StatusContext {
  private readonly detail: PlanAppDetail | undefined
  private readonly modelsById: Map<string, PlanModel>
  private readonly actionKeys: Map<string, string>
  private readonly viewsById: Map<string, PlanView>
  private readonly namesById: Map<string, string>

  constructor(private readonly plan: PlanDraft, private readonly app: PlanAppState) {
    this.detail = app.detail
    this.modelsById = new Map(plan.models.map((model) => [model.id, model]))
    this.actionKeys = new Map(
      plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, `${controller.className}.${action.name}`] as const)),
    )
    this.viewsById = new Map(plan.views.map((view) => [view.id, view]))
    this.namesById = new Map([...plan.validators, ...plan.resources, ...plan.policies].map((element) => [element.id, element.name]))
  }

  private section<K extends 'routes' | 'tables' | 'models' | 'actions' | 'controllers' | 'pages' | 'validators'>(key: K): PlanAppDetail[K] | PlanAppUnreadable {
    return this.detail ? this.detail[key] : NO_DETAIL
  }

  named(
    section: PlanElementSection,
    element: { id: string; change: PlanChange; name: string; module?: string },
    names: PlanAppNames,
    what: string,
    unread: string[],
  ): PlanElementStatus {
    const classes = section === 'resources' ? this.detail?.resources : this.detail?.policies
    const find = (name: string): Existence =>
      inScope(inSection(names, name, what), element.module, matching(classes, (entry) => entry.className === name), what.replace(/s$/, ''))
    return conclude({
      id: element.id,
      section,
      change: element.change,
      label: element.name,
      exists: find(element.name),
      previous: previousOf(element.change, find),
      properties: () => unread.map((property) => unknown(property, 'as planned', `nothing reads a ${section.replace(/s$/, '')}'s ${property}`)),
    })
  }

  /**
   * The table the model binds, looked up in the app root the plan puts the model in.
   * A same-named table in another root is a different table, and judging columns
   * against it is how a model nobody wrote reads as written.
   */
  private tableOf(model: PlanModel): SourcedSchemaTable | undefined | PlanAppUnreadable {
    const tables = this.section('tables')
    if (isUnreadable(tables)) return tables
    const scope = tables.filter((table) => table.module === (model.module ?? null))
    const byName = (within: ReadonlyArray<SourcedSchemaTable>, name: string): SourcedSchemaTable | undefined =>
      within.find((table) => table.tableName === name) ?? within.find((table) => table.tableName === undefined && table.identifier === name)
    const find = (within: ReadonlyArray<SourcedSchemaTable>): SourcedSchemaTable | undefined =>
      byName(within, model.table) ?? (model.tableRenamedFrom ? byName(within, model.tableRenamedFrom) : undefined)

    const found = find(scope)
    if (found || !find(tables)) return found
    return { unreadable: `no table named "${model.table}" is declared in ${scopeName(model.module)}, and another app root declares one` }
  }

  /** A file named after the class that yielded no model is a class this cannot call absent. */
  private modelExistence(name: string, module: string | undefined): Existence {
    const found = inSection(this.app.models, name, 'models')
    const unparsed = this.detail?.unparsedModelFiles.find((file) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '') === name)
    if (found === 'no' && unparsed) return { unknown: `${unparsed} exists and no model class could be read from it` }
    return inScope(found, module, matching(this.section('models'), (entry) => entry.className === name), 'model')
  }

  model(model: PlanModel): PlanElementStatus {
    return conclude({
      id: model.id,
      section: 'models',
      change: model.change,
      label: model.name,
      exists: this.modelExistence(model.name, model.module),
      previous: previousOf(model.change, (from) => this.modelExistence(from, model.module)),
      properties: () => this.modelProperties(model),
    })
  }

  private modelProperties(model: PlanModel): PlanPropertyStatus[] {
    const properties: PlanPropertyStatus[] = []
    const models = this.section('models')
    const tables = this.section('tables')
    const actual = isUnreadable(models)
      ? undefined
      : models.find((candidate) => candidate.className === model.name && candidate.module === (model.module ?? null))
    const whyNoModel = isUnreadable(models) ? `the models could not be read (${models.unreadable})` : 'the model class did not parse'

    if (model.change.kind !== 'alter' || model.tableRenamedFrom) {
      const bound = actual?.table && !isUnreadable(tables) ? tables.find((table) => table.identifier === actual.table && table.module === actual.module) : undefined
      const boundName = bound ? (bound.tableName ?? bound.identifier) : undefined
      properties.push(compare('table', model.table, boundName, isUnreadable(tables) ? `the schema could not be read (${tables.unreadable})` : 'the table the class binds was not found in the schema'))
    }
    if (model.tableRenamedFrom && !isUnreadable(tables)) {
      const old = tables.some((table) => (table.tableName ?? table.identifier) === model.tableRenamedFrom)
      properties.push(old ? differ('previous table removed', model.tableRenamedFrom, 'still present') : match('previous table removed', model.tableRenamedFrom, 'absent'))
    }

    for (const relationship of model.relationships) {
      const property = `relationship ${relationship.name}`
      const target = this.modelsById.get(relationship.target)?.name ?? relationship.target
      const planned = `${relationship.type} ${target}`
      if (!actual) {
        properties.push(unknown(property, planned, whyNoModel))
        continue
      }
      const found = actual.relationships.find((candidate) => candidate.name === relationship.name)
      if (!found) {
        properties.push(differ(property, planned, 'not declared'))
        continue
      }
      // Two properties: a target written as a lazy import is one the parser cannot name,
      // and that must not hide a relationship whose name and type it did read.
      properties.push(compare(property, relationship.type, found.type, ''))
      properties.push(compare(`${property} target`, target, found.relatedModel, 'the related model is not written as a class the parser can name'))
    }

    for (const name of model.fillable) {
      const property = `fillable ${name}`
      if (!actual || actual.fillable === 'unreadable') properties.push(unknown(property, 'listed', actual ? 'fillable is not a literal array' : whyNoModel))
      else properties.push(actual.fillable?.includes(name) ? match(property, 'listed') : differ(property, 'listed', 'not listed'))
    }

    const table = this.tableOf(model)
    for (const index of model.indexes) {
      const property = `${index.unique ? 'unique index' : 'index'} (${index.columns.join(', ')})`
      if (!table || tableUnread(table)) {
        properties.push(unknown(property, 'declared', table ? `the table could not be resolved (${table.unreadable})` : 'the table was not found in the schema'))
        continue
      }
      const found = hasIndex(table, index.columns, index.unique ? ['uniqueIndex', 'unique'] : ['index'])
      properties.push(found === undefined ? unknown(property, 'declared', CONSTRAINTS_HIDDEN) : found ? match(property, 'declared') : differ(property, 'declared', 'not declared'))
    }
    return properties
  }

  column(model: PlanModel, column: PlanColumn): PlanElementStatus {
    const table = this.tableOf(model)
    const find = (name: string): Existence => {
      if (tableUnread(table)) return { unknown: `the table could not be resolved (${table.unreadable})` }
      if (!table) return 'no'
      if (table.columns.some((candidate) => candidate.name === name)) return 'yes'
      return table.opaqueColumns ? { unknown: `the columns of "${table.identifier}" hold a spread or a computed key, and the schema did not import (${table.runtimeUnreadable ?? 'no reason given'})` } : 'no'
    }
    return conclude({
      id: column.id,
      section: 'columns',
      change: column.change,
      label: `${model.table}.${column.name}`,
      exists: find(column.name),
      previous: previousOf(column.change, find),
      properties: () => this.columnProperties(column, table as SourcedSchemaTable),
    })
  }

  private columnProperties(column: PlanColumn, table: SourcedSchemaTable): PlanPropertyStatus[] {
    const actual = table.columns.find((candidate) => candidate.name === column.name)!
    const properties: PlanPropertyStatus[] = []
    // A chain that does not start at a drizzle builder hides its modifiers: false is "not visible".
    const hidden = actual.opaqueBuilder === true
    const BUILDER_HIDDEN = 'the column is built by a helper the static reader cannot follow'
    // `seen` is the modifier as written; `actual` is what the plan's property then reads as.
    const flag = (property: string, planned: boolean, seen: boolean, actual = seen): void => {
      if (!seen && hidden) properties.push(unknown(property, String(planned), BUILDER_HIDDEN))
      else properties.push(compare(property, String(planned), String(actual), ''))
    }

    const builder = builderOf(actual)
    const projection = COLUMN_TYPE_BUILDERS[column.type]
    if (builder === undefined) properties.push(unknown('type', column.type, BUILDER_HIDDEN))
    else if (projection.accepts.includes(builder)) properties.push(match('type', column.type, builder))
    else if (projection.ambiguous.includes(builder)) properties.push(unknown('type', column.type, `"${builder}" may hold a ${column.type} under a mode no reader reports`))
    else properties.push(differ('type', column.type, builder))

    const notNull = actual.notNull || actual.primaryKey
    flag('nullable', column.nullable, notNull, !notNull)
    if (column.primaryKey !== undefined) {
      const composite = hasIndex(table, [column.name], ['primaryKey'])
      flag('primaryKey', column.primaryKey, actual.primaryKey || composite === true)
    }

    const uniqueIndex = hasIndex(table, [column.name], ['unique', 'uniqueIndex'])
    if (actual.unique || uniqueIndex === true) properties.push(compare('unique', String(column.unique), 'true', ''))
    else if (hidden || uniqueIndex === undefined) properties.push(unknown('unique', String(column.unique), hidden ? BUILDER_HIDDEN : CONSTRAINTS_HIDDEN))
    else properties.push(compare('unique', String(column.unique), 'false', ''))

    const index = hasIndex(table, [column.name], ['index'])
    properties.push(index === undefined ? unknown('index', String(column.index), CONSTRAINTS_HIDDEN) : compare('index', String(column.index), String(index), ''))

    if (column.columnName !== undefined) {
      properties.push(compare('columnName', column.columnName, actual.columnName, 'the builder is given no name, and the casing drizzle derives one under is not read'))
    }
    if (column.withTimezone !== undefined) {
      const written = actual.withTimezone ?? (table.dialect === 'pg' && builder === 'timestamp' && !actual.opaqueOptions && !hidden ? false : undefined)
      properties.push(compare('withTimezone', String(column.withTimezone), written === undefined ? undefined : String(written), 'the builder options are not visible'))
    }
    if (column.precision !== undefined || column.scale !== undefined) {
      const planned = `${column.precision ?? '?'},${column.scale ?? '?'}`
      const sized = actual.sqlType?.match(/\((\d+)\s*(?:,\s*(\d+))?\)/)
      const found = sized ? `${column.precision === undefined ? '?' : sized[1]},${column.scale === undefined ? '?' : (sized[2] ?? '0')}` : undefined
      properties.push(compare('precision,scale', planned, found, 'precision and scale are read from the runtime SQL type only'))
    }
    if (column.default !== undefined) properties.push(this.defaultProperty(column.default, actual, hidden))
    if (column.references) properties.push(...this.referenceProperties(column, actual, hidden))
    return properties
  }

  private defaultProperty(planned: string, actual: RuntimeSchemaColumn, hidden: boolean): PlanPropertyStatus {
    if (actual.opaqueDefault) return unknown('default', planned, 'the default holds an SQL chunk this reader cannot render')
    if (!actual.default) {
      if (actual.runtimeDefault) return unknown('default', planned, 'the column has a `$defaultFn`, which the database never sees')
      return hidden ? unknown('default', planned, 'the column is built by a helper the static reader cannot follow') : differ('default', planned, 'none')
    }
    const text = defaultText(actual.default)
    if (text === undefined) return unknown('default', planned, 'a random default has no text to compare')
    if (normalizeDefault(text) === normalizeDefault(planned)) return match('default', planned, text)
    // Two SQL expressions may differ as text and agree as SQL; two literals may not.
    return actual.default.kind === 'value' ? differ('default', planned, text) : unknown('default', planned, `the SQL default \`${text}\` is compared as text only`)
  }

  private referenceProperties(column: PlanColumn, actual: RuntimeSchemaColumn, hidden: boolean): PlanPropertyStatus[] {
    const reference = column.references!
    const target = this.modelsById.get(reference.model)
    const targetTable = target ? this.tableOf(target) : undefined
    const planned = `${target?.table ?? reference.model}.${reference.column}`
    const properties: PlanPropertyStatus[] = []
    if (!actual.references) {
      properties.push(hidden ? unknown('references', planned, 'the column is built by a helper the static reader cannot follow') : differ('references', planned, 'none'))
    } else if (!targetTable || tableUnread(targetTable)) {
      properties.push(unknown('references', planned, 'the referenced table was not found in the schema'))
    } else {
      const found = `${actual.references.table === targetTable.identifier ? (target?.table ?? reference.model) : actual.references.table}.${actual.references.column}`
      properties.push(compare('references', planned, found, ''))
    }
    if (reference.onDelete) properties.push(unknown('references.onDelete', reference.onDelete, 'no reader reports a foreign key action'))
    return properties
  }

  validator(validator: PlanDraft['validators'][number]): PlanElementStatus {
    const validators = this.section('validators')
    const names = isUnreadable(validators) ? validators : validators.map((candidate) => candidate.name)
    const find = (name: string): Existence =>
      inScope(inSection(names, name, 'validators'), validator.module, matching(validators, (entry) => entry.name === name), 'validator')
    return conclude({
      id: validator.id,
      section: 'validators',
      change: validator.change,
      label: validator.name,
      exists: find(validator.name),
      previous: previousOf(validator.change, find),
      properties: () => (validator.fields.length > 0 ? [unknown('fields', 'as planned', "nothing reads a schema's fields without evaluating it")] : []),
      mount: () => this.referenceMount(validator.name),
    })
  }

  private controllerExistence(className: string, module: string | undefined): Existence {
    if (this.detail?.controllerCollisions.includes(className)) {
      return { unknown: `two controller files declare "${className}", and a route names a class, never a file` }
    }
    const found = inSection(this.app.controllers, className, 'controllers')
    return inScope(found, module, matching(this.section('controllers'), (entry) => entry.className === className), 'controller')
  }

  controller(controller: PlanController): PlanElementStatus {
    return conclude({
      id: controller.id,
      section: 'controllers',
      change: controller.change,
      label: controller.className,
      exists: this.controllerExistence(controller.className, controller.module),
      previous: previousOf(controller.change, (from) => this.controllerExistence(from, controller.module)),
    })
  }

  action(controller: PlanController, action: PlanAction): PlanElementStatus {
    const key = `${controller.className}.${action.name}`
    // An action has no app root of its own: it is declared by its controller's class.
    const find = (name: string): Existence => {
      const owner = this.controllerExistence(controller.className, controller.module)
      if (typeof owner === 'object') return owner
      const actionKey = `${controller.className}.${name}`
      const found = inSection(this.app.actions, actionKey, 'controller actions')
      return inScope(found, controller.module, matching(this.section('actions'), (entry) => entry.key === actionKey), 'controller')
    }
    return conclude({
      id: action.id,
      section: 'actions',
      change: action.change,
      label: key,
      exists: find(action.name),
      previous: previousOf(action.change, find),
      properties: () => this.actionProperties(action, key),
      mount: () => this.actionMount(key),
    })
  }

  private actionBody(key: string): PlanAppActionDetail | undefined {
    const actions = this.section('actions')
    return isUnreadable(actions) ? undefined : actions.find((candidate) => candidate.key === key)
  }

  /** A body scan answers "the body mentions it", so a miss is `unknown`: a helper may do the work. */
  private actionProperties(action: PlanAction, key: string): PlanPropertyStatus[] {
    const body = this.actionBody(key)
    const properties: PlanPropertyStatus[] = []
    const NOT_IN_BODY = 'the action body does not mention it, and a helper or the route contract may'
    const mentions = (property: string, id: string): void => {
      const name = this.namesById.get(id) ?? id
      properties.push(body?.identifiers.includes(name) ? match(property, name) : unknown(property, name, NOT_IN_BODY))
    }

    for (const field of ['params', 'query', 'body'] as const) {
      const id = action[field]
      if (id) mentions(`${field} validator`, id)
    }
    const policy = action.authorization.policy
    if (policy) {
      if (body?.abilities.includes(policy.ability)) properties.push(match('policy ability', policy.ability))
      else if (body && body.abilities.length > 0) properties.push(differ('policy ability', policy.ability, body.abilities.join(', ')))
      else properties.push(unknown('policy ability', policy.ability, 'the action body authorizes no literal ability, and middleware may'))
    }

    const response = action.response
    if (response.kind === 'inertia') {
      const page = this.viewsById.get(response.view)?.page ?? response.view
      if (body?.pages.includes(page)) properties.push(match('response page', page))
      else if (body && body.pages.length > 0) properties.push(differ('response page', page, body.pages.join(', ')))
      else properties.push(unknown('response page', page, 'the action body returns no page this scan can name'))
    } else if (response.kind === 'resource') {
      mentions('response resource', response.resource)
    } else if (response.kind === 'redirect') {
      properties.push(body?.calls.includes('redirect') ? match('response', 'redirect') : unknown('response', 'redirect', 'the action body calls no this.redirect()'))
    }
    return properties
  }

  private routesTo(key: string): PlanAppRouteDetail[] | PlanAppUnreadable {
    const routes = this.section('routes')
    return isUnreadable(routes) ? routes : routes.filter((route) => route.action === key)
  }

  private routeMount(route: PlanAppRouteDetail): PlanAppMount {
    const mounts = this.detail!.mounts
    return route.module === null ? mounts.entry : (mounts.modules[route.module] ?? { unconfirmed: `nothing was read about modules/${route.module}` })
  }

  private actionMount(key: string): PlanAppMount {
    const routes = this.routesTo(key)
    if (isUnreadable(routes)) return { unconfirmed: `the routes could not be read (${routes.unreadable})` }
    if (routes.length === 0) return { unconfirmed: `no registered route dispatches to ${key}` }
    const mounts = routes.map((route) => this.routeMount(route))
    return mounts.includes('mounted') ? 'mounted' : mounts[0]!
  }

  /**
   * Mounted when a mounted action validates with the symbol, or the entry routes file
   * names it in a route contract. A bare mention is not evidence: an identifier can be
   * named by a leftover import, in a type position or in a branch nothing reaches, and
   * none of those is a use. Such a mention only explains why this stayed unconfirmed.
   */
  private referenceMount(symbol: string): PlanAppMount {
    if (!this.detail) return { unconfirmed: NO_DETAIL.unreadable }
    const actions = this.section('actions')
    const reasons: string[] = []
    const mentions: string[] = []

    for (const action of isUnreadable(actions) ? [] : actions) {
      if (!action.validates.includes(symbol)) {
        if (action.identifiers.includes(symbol)) mentions.push(`${action.key} mentions it without validating with it`)
        continue
      }
      const mount = this.actionMount(action.key)
      if (mount === 'mounted') return 'mounted'
      reasons.push(`${action.key} validates with it, and ${mount.unconfirmed}`)
    }

    for (const file of this.detail.routeFiles) {
      if (!file.contractIdentifiers.includes(symbol)) {
        if (file.identifiers.includes(symbol)) mentions.push(`${file.file} mentions it outside a route contract`)
        continue
      }
      if (!file.entry) {
        reasons.push(`${file.file} names it in a route contract, and only the routes file the application loads is evidence of mounting`)
        continue
      }
      if (this.detail.mounts.entry === 'mounted') return 'mounted'
      reasons.push(`${file.file} names it in a route contract, and ${this.detail.mounts.entry.unconfirmed}`)
    }

    return { unconfirmed: reasons[0] ?? mentions[0] ?? 'no route contract names it and no action body validates with it' }
  }

  route(route: PlanRoute): PlanElementStatus {
    const routes = this.section('routes')
    const find = (name: string): Existence => {
      if (isUnreadable(routes)) return { unknown: `the routes could not be read (${routes.unreadable})` }
      const found = routes.filter((candidate) => candidate.name === name)
      if (found.length > 1) return { unknown: `${found.length} registered routes share the name "${name}"` }
      if (found.length === 1) return 'yes'
      return this.detail?.routesIncomplete ? { unknown: `a module's routes did not load, so an absent route proves nothing (${this.detail.routesIncomplete})` } : 'no'
    }
    const actual = (): PlanAppRouteDetail => (routes as PlanAppRouteDetail[]).find((candidate) => candidate.name === route.name)!
    return conclude({
      id: route.id,
      section: 'routes',
      change: route.change,
      label: route.name,
      exists: find(route.name),
      previous: previousOf(route.change, find),
      properties: () => this.routeProperties(route, actual()),
      mount: () => this.routeMount(actual()),
    })
  }

  private routeProperties(route: PlanRoute, actual: PlanAppRouteDetail): PlanPropertyStatus[] {
    const action = this.actionKeys.get(route.action) ?? route.action
    const properties = [
      compare('method', route.method, actual.method.toUpperCase(), ''),
      compare('path', route.path, actual.path, ''),
      actual.prototype
        ? differ('action', action, 'the prototype handler')
        : compare('action', action, actual.action, 'the route is served by an inline handler'),
    ]
    for (const name of route.middleware) {
      const property = `middleware ${name}`
      if (actual.middleware.includes(name)) properties.push(match(property, 'applied'))
      else if (actual.hasInlineMiddleware) properties.push(unknown(property, 'applied', 'the route carries an inline middleware, which has no name'))
      else properties.push(differ(property, 'applied', 'not applied'))
    }
    for (const binding of route.bind) {
      const model = this.modelsById.get(binding.model)?.name ?? binding.model
      properties.push(compare(`bind ${binding.param}`, model, actual.bindings[binding.param] ?? 'not bound', ''))
      if (binding.key) properties.push(unknown(`bind ${binding.param} key`, binding.key, 'the lookup column of a binding is not read'))
    }
    if (route.agent) {
      if (!actual.agent) properties.push(differ('agent', route.agent.toolName, 'not an agent tool'))
      else {
        properties.push(compare('agent toolName', route.agent.toolName, actual.agent.toolName ?? actual.name, ''))
        properties.push(compare('agent readOnly', String(route.agent.readOnly), actual.agent.readOnly === undefined ? undefined : String(actual.agent.readOnly), 'the route states no readOnlyHint, and the default is derived at runtime'))
      }
    }
    return properties
  }

  view(view: PlanView): PlanElementStatus {
    // A module's pages are not colocated: they live in the project's own
    // resources/js/pages under the module's name, which the page id then carries.
    // So a page the scan found is positively the project's, and only a plan that
    // names a module without that prefix is one this cannot place.
    const find = (page: string): Existence => {
      const found = inSection(this.app.pages, page, 'pages')
      if (found !== 'yes' || view.module === undefined || page.startsWith(`${view.module}/`)) return found
      return { unknown: `the plan puts the page in modules/${view.module}, and a module's pages are namespaced as "${view.module}/${page}" under the project's own resources/js/pages` }
    }
    return conclude({
      id: view.id,
      section: 'views',
      change: view.change,
      label: view.page,
      exists: find(view.page),
      previous: previousOf(view.change, find),
      properties: () => this.viewProperties(view),
      mount: () => this.viewMount(view.page),
    })
  }

  private viewProperties(view: PlanView): PlanPropertyStatus[] {
    const pages = this.section('pages')
    const props = isUnreadable(pages) ? undefined : pages.find((candidate) => candidate.id === view.page)?.props
    const properties = view.props.map((prop): PlanPropertyStatus => {
      const property = `prop ${prop.name}`
      if (props?.status === 'keys') {
        return props.keys.some((key) => key.name === prop.name) ? match(property, 'declared') : differ(property, 'declared', 'not declared')
      }
      const reason = !props ? 'the page could not be read' : props.status === 'unreadable' ? `the page's Props could not be read (${props.reason})` : 'the page declares no Props type'
      return unknown(property, 'declared', reason)
    })
    const NO_READER = 'nothing reads what a page renders'
    if (view.form) properties.push(unknown('form', 'as planned', NO_READER))
    if (view.actions.length > 0) properties.push(unknown('actions', 'as planned', NO_READER))
    if (Object.values(view.states).some((state) => state !== undefined)) properties.push(unknown('states', 'as planned', NO_READER))
    return properties
  }

  private viewMount(page: string): PlanAppMount {
    const actions = this.section('actions')
    if (isUnreadable(actions)) return { unconfirmed: `the controller actions could not be read (${actions.unreadable})` }
    const returning = actions.filter((action) => action.pages.includes(page))
    if (returning.length === 0) return { unconfirmed: 'no controller action returns this page' }
    const mounts = returning.map((action) => this.actionMount(action.key))
    return mounts.includes('mounted') ? 'mounted' : { unconfirmed: `${returning[0]!.key} returns it, and ${(mounts[0] as { unconfirmed: string }).unconfirmed}` }
  }

  sideEffect(effect: PlanDraft['sideEffects'][number]): PlanElementStatus {
    const base = { id: effect.id, section: 'sideEffects' as const, change: effect.change, label: effect.name }
    const readable: ReadonlyArray<string> = ['job', 'event', 'listener'] satisfies PlanAppSideEffectKind[]
    if (!readable.includes(effect.kind)) return conclude({ ...base, exists: 'no', unjudged: `Nothing discovers a ${effect.kind} class.` })
    const classes = this.detail?.sideEffects[effect.kind as PlanAppSideEffectKind]
    const names: PlanAppNames = classes ? classes.map((entry) => entry.className) : NO_DETAIL
    const find = (name: string): Existence =>
      inScope(inSection(names, name, `${effect.kind} classes`), effect.module, matching(classes, (entry) => entry.className === name), effect.kind)
    return conclude({
      ...base,
      exists: find(effect.name),
      previous: previousOf(effect.change, find),
    })
  }
}
