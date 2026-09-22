/**
 * The status of a plan against the code (RFC 0030 §6), as one pure function of the plan
 * and the application state. It reads no file and runs nothing: `verified` and `waived`
 * belong to `plan:verify` and `plan:waive`, which upgrade a result from here.
 * A planned property is compared only as finely as its reader reads it. One with no
 * reader is `unknown`, which never counts towards `present` and never satisfies a `drop`.
 */

import { CONTRACT_SEGMENTS } from '../contract-segments'
import type { SchemaColumnDefault, SchemaConstraint } from '../schema-parser'
import type { RuntimeSchemaColumn, SourcedSchemaTable } from '../schema-runtime'
import type {
  PlanAppActionDetail,
  PlanAppDetail,
  PlanAppMount,
  PlanAppRouteDetail,
  PlanAppSideEffectKind,
  PlanAppValidatorDetail,
} from './app-detail'
import { isUnreadable, scopeName, type PlanAppNames, type PlanAppState, type PlanAppUnreadable } from './app-state'
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

export const PLAN_ELEMENT_STATES = ['planned', 'present', 'wired', 'verified', 'drifted', 'unjudged', 'blocked', 'waived'] as const satisfies readonly PlanElementState[]

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
  /**
   * The state this element completes at before verification (RFC 0030 §6, Completion):
   * `wired` for a kind with a mount point, `present` for the rest and for a `drop`.
   */
  completesAt: 'present' | 'wired'
  /** App-relative files the readers found the element in; what `plan:verify` fingerprints. Empty until it exists. */
  files: string[]
}

export interface PlanStatusSummary {
  /** Elements the plan changes, per state. `existing` elements are counted apart. */
  states: Record<PlanElementState, number>
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
  /** Asked only once the element exists. */
  files?: () => string[]
  /** No reader exists for this kind of element at all. */
  unjudged?: string
  notes?: string[]
}

/**
 * Whether `plan:verify` may lift this element to `verified`: it is at the state its kind
 * completes at, or has no static signal and is verified on its behaviours alone (RFC 0030
 * §6, Completion). An `existing` element is never part of completion.
 */
export function awaitsVerification(element: PlanElementStatus<PlanElementState>): boolean {
  if (element.change === 'existing') return false
  return element.state === 'unjudged' || element.state === element.completesAt
}

const match = (property: string, planned: string, actual = planned): PlanPropertyStatus => ({ property, verdict: 'match', planned, actual })
const differ = (property: string, planned: string, actual: string): PlanPropertyStatus => ({ property, verdict: 'differ', planned, actual })
const unknown = (property: string, planned: string, reason: string): PlanPropertyStatus => ({ property, verdict: 'unknown', planned, reason })

function compare(property: string, planned: string, actual: string | undefined, whyUnknown: string): PlanPropertyStatus {
  if (actual === undefined) return unknown(property, planned, whyUnknown)
  return actual === planned ? match(property, planned) : differ(property, planned, actual)
}

function conclude(judgement: Judgement): PlanElementStatus {
  const { id, section, change, label, exists } = judgement
  const base = {
    id,
    section,
    change: change.kind,
    label,
    completesAt: change.kind !== 'drop' && judgement.mount ? ('wired' as const) : ('present' as const),
    files: exists === 'yes' ? (judgement.files?.() ?? []) : [],
  }
  const notes = [...(judgement.notes ?? [])]
  const done = (state: PlanStatusState, extra: Partial<PlanElementStatus> = {}): PlanElementStatus => ({
    ...base,
    state,
    properties: [],
    notes,
    ...extra,
  })

  if (judgement.unjudged) return done('unjudged', { reason: judgement.unjudged })
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
  // A mount is a reading of the element itself; with none, existence would complete what the plan stated and nothing read.
  if (properties.length > 0 && readable.length === 0 && !judgement.mount) {
    return result('unjudged', { reason: 'No planned property of this element could be read, and its existence says nothing about them.' })
  }
  if (change.kind === 'alter' && differing.length > 0 && differing.length === readable.length) return result('planned')
  const withheld = differing.filter((property) => WITHHOLDS_MOUNT.has(property))
  if (differing.length > withheld.length) return result('drifted')

  if (withheld.length > 0) {
    notes.push(`Not wired: ${withheld.map(unusedValidator).join('; ')}.`)
    return result('present')
  }
  if (!judgement.mount) return result('present')
  const mount = judgement.mount()
  if (mount === 'mounted') return result('wired')
  notes.push(`Not confirmed as wired: ${mount.unconfirmed}.`)
  return result('present')
}

/** How a kind of element is named in a message. Both forms are spelled: deriving one gives "policie". */
interface PlanNoun {
  plural: string
  singular: string
}

const NOUNS = {
  models: { plural: 'models', singular: 'model' },
  controllers: { plural: 'controllers', singular: 'controller' },
  actions: { plural: 'controller actions', singular: 'controller' },
  validators: { plural: 'validators', singular: 'validator' },
  resources: { plural: 'resources', singular: 'resource' },
  policies: { plural: 'policies', singular: 'policy' },
} as const satisfies Record<string, PlanNoun>

function inSection(section: PlanAppNames, name: string, plural: string): Existence {
  if (isUnreadable(section)) return { unknown: `the application's ${plural} could not be read (${section.unreadable})` }
  return section.some((entry) => entry.name === name) ? 'yes' : 'no'
}

/**
 * Whether the application holds this name, in the app root the plan puts it in:
 * `modules/<name>`, or the project root when the plan states none. `entries` is what
 * the detail scan found under that name, `undefined` meaning no reader says where any
 * of it came from — which is unknown whichever root the plan names, since a match
 * either way would be a guess.
 */
function existsInScope<T extends { module: string | null }>(
  names: PlanAppNames,
  name: string,
  noun: PlanNoun,
  declared: string | undefined,
  entries: T[] | PlanAppUnreadable | undefined,
  matches: (entry: T) => boolean,
): Existence {
  const found = inSection(names, name, noun.plural)
  if (found !== 'yes') return found
  if (entries === undefined || isUnreadable(entries)) return { unknown: `nothing reads which app root each ${noun.singular} sits in` }
  return entries.some((entry) => matches(entry) && entry.module === (declared ?? null)) ? 'yes' : 'no'
}

/** The file of the discovered class matching a name in the plan's app root, as a list for `files`. */
function classFiles(
  classes: ReadonlyArray<{ className: string; module: string | null; file: string }> | undefined,
  name: string,
  module: string | undefined,
): string[] {
  const found = classes?.find((entry) => entry.className === name && entry.module === (module ?? null))
  return found ? [found.file] : []
}

/**
 * Why a table name the plan's own app root does not declare is no answer either way:
 * every root's schema is re-exported from one `db/schema.ts`, so the table another root
 * declares may well be this one.
 */
function tableElsewhere(name: string, module: string | undefined): string {
  return `no table named "${name}" is declared in ${scopeName(module)}, and another app root declares one`
}

function tableUnread(table: SourcedSchemaTable | PlanAppUnreadable | undefined): table is PlanAppUnreadable {
  return table !== undefined && 'unreadable' in table
}

function previousOf(change: PlanChange, lookup: (name: string) => Existence): Existence | undefined {
  return change.kind === 'rename' ? lookup(change.from) : undefined
}

/** A `differ` that holds its element at `present` instead of drifting it: a use the code does not make yet. */
const WITHHOLDS_MOUNT = new WeakSet<PlanPropertyStatus>()

function withholding(property: PlanPropertyStatus): PlanPropertyStatus {
  WITHHOLDS_MOUNT.add(property)
  return property
}

const NO_VALIDATE_CALL = 'no validate call'

function unusedValidator(property: PlanPropertyStatus): string {
  const head = `${property.property} ${property.planned} is not used`
  if (property.actual === NO_VALIDATE_CALL) return `${head} (the body calls no validate method, and no route contract holds it)`
  // The scan names a member chain as written, never the export it evaluates to.
  const chain = property.actual?.split(', ').find((name) => name.includes('.'))
  if (chain) return `${head} (the body validates with ${property.actual}; ${chain} cannot be read as an export, so validate with ${property.planned} by name or hold it in the route contract)`
  return `${head} (the body validates with ${property.actual})`
}

/**
 * Whether a registered route to an action holds `symbol` as a contract schema. Any segment
 * counts: `contractSchemas` does not say which, so a `query` contract satisfies a planned `body`.
 */
function contractHolds(route: PlanAppRouteDetail, symbol: string): boolean {
  return route.contractSchemas.includes(symbol)
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
    ...plan.resources.map((resource) => context.named('resources', resource, app.resources, NOUNS.resources, resource.fields.length > 0 ? ['fields'] : [])),
    ...plan.policies.map((policy) => context.named('policies', policy, app.policies, NOUNS.policies, policy.abilities.length > 0 ? ['abilities'] : [])),
    ...plan.sideEffects.map((effect) => context.sideEffect(effect)),
    ...plan.commands.map((command): PlanElementStatus =>
      conclude({ id: command.id, section: 'commands', change: { kind: 'add' }, label: command.command, exists: 'no', unjudged: 'Nothing reads whether a command has been run.' }),
    ),
  ]
  return { elements, summary: summarize(elements) }
}

export function summarize(elements: ReadonlyArray<PlanElementStatus<PlanElementState>>): PlanStatusSummary {
  const states = Object.fromEntries(PLAN_ELEMENT_STATES.map((state) => [state, 0])) as Record<PlanElementState, number>
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
    noun: PlanNoun,
    unread: string[],
  ): PlanElementStatus {
    const classes = section === 'resources' ? this.detail?.resources : this.detail?.policies
    const find = (name: string): Existence =>
      existsInScope(names, name, noun, element.module, classes, (entry) => entry.className === name)
    return conclude({
      id: element.id,
      section,
      change: element.change,
      label: element.name,
      exists: find(element.name),
      previous: previousOf(element.change, find),
      properties: () => unread.map((property) => unknown(property, 'as planned', `nothing reads a ${noun.singular}'s ${property}`)),
      files: () => classFiles(classes, element.name, element.module),
    })
  }

  /**
   * The table the model binds, looked up in the app root the plan puts the model in.
   * Another root's may be the same SQL table, which is why that answers nothing rather
   * than matching: judging columns against it is how a model nobody wrote reads as written.
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
    return { unreadable: tableElsewhere(model.table, model.module) }
  }

  /** A file named after the class that yielded no model is a class this cannot call absent. */
  private modelExistence(name: string, module: string | undefined): Existence {
    const found = existsInScope(this.app.models, name, NOUNS.models, module, this.section('models'), (entry) => entry.className === name)
    // `no` also covers a class only another app root declares, and an unparsed file
    // carries no root, so such a file makes that answer unknown too.
    const unparsed = this.detail?.unparsedModelFiles.find((file) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '') === name)
    if (found === 'no' && unparsed) return { unknown: `${unparsed} exists and no model class could be read from it` }
    return found
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
      files: () => {
        const models = this.section('models')
        return classFiles(isUnreadable(models) ? undefined : models, model.name, model.module)
      },
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
      const named = (within: ReadonlyArray<SourcedSchemaTable>): boolean =>
        within.some((table) => (table.tableName ?? table.identifier) === model.tableRenamedFrom)
      const property = 'previous table removed'
      const scope = tables.filter((table) => table.module === (model.module ?? null))
      // Scoped like the table the model binds, and hedged for the same reason.
      if (named(scope)) properties.push(differ(property, model.tableRenamedFrom, 'still present'))
      else if (named(tables)) properties.push(unknown(property, model.tableRenamedFrom, tableElsewhere(model.tableRenamedFrom, model.module)))
      else properties.push(match(property, model.tableRenamedFrom, 'absent'))
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
      files: () => [(table as SourcedSchemaTable).file],
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
    const find = (name: string): Existence =>
      existsInScope(validators, name, NOUNS.validators, validator.module, validators, (entry) => entry.name === name)
    const found = isUnreadable(validators)
      ? undefined
      : validators.find((entry) => entry.name === validator.name && entry.module === (validator.module ?? null))
    return conclude({
      id: validator.id,
      section: 'validators',
      change: validator.change,
      label: validator.name,
      exists: find(validator.name),
      previous: previousOf(validator.change, find),
      properties: () => (validator.fields.length > 0 ? [unknown('fields', 'as planned', "nothing reads a schema's fields without evaluating it")] : []),
      mount: () => this.referenceMount(validator.name, found),
      files: () => (found ? [found.file] : []),
    })
  }

  private controllerExistence(className: string, module: string | undefined): Existence {
    if (this.detail?.controllerCollisions.includes(className)) {
      return { unknown: `two controller files declare "${className}", and a route names a class, never a file` }
    }
    return existsInScope(this.app.controllers, className, NOUNS.controllers, module, this.section('controllers'), (entry) => entry.className === className)
  }

  controller(controller: PlanController): PlanElementStatus {
    return conclude({
      id: controller.id,
      section: 'controllers',
      change: controller.change,
      label: controller.className,
      exists: this.controllerExistence(controller.className, controller.module),
      previous: previousOf(controller.change, (from) => this.controllerExistence(from, controller.module)),
      files: () => this.controllerFiles(controller.className, controller.module),
    })
  }

  private controllerFiles(className: string, module: string | undefined): string[] {
    const controllers = this.section('controllers')
    return classFiles(isUnreadable(controllers) ? undefined : controllers, className, module)
  }

  action(controller: PlanController, action: PlanAction): PlanElementStatus {
    const key = `${controller.className}.${action.name}`
    // An action has no app root of its own: it is declared by its controller's class.
    const find = (name: string): Existence => {
      const owner = this.controllerExistence(controller.className, controller.module)
      if (typeof owner === 'object') return owner
      const actionKey = `${controller.className}.${name}`
      return existsInScope(this.app.actions, actionKey, NOUNS.actions, controller.module, this.section('actions'), (entry) => entry.key === actionKey)
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
      files: () => this.controllerFiles(controller.className, controller.module),
    })
  }

  private actionBody(key: string): PlanAppActionDetail | undefined {
    const actions = this.section('actions')
    return isUnreadable(actions) ? undefined : actions.find((candidate) => candidate.key === key)
  }

  /**
   * A body scan answers "the body mentions it", so a missed mention is `unknown`: a helper may
   * do the work. A validator is read off the call that takes it, so a readable body without one differs.
   */
  private actionProperties(action: PlanAction, key: string): PlanPropertyStatus[] {
    const body = this.actionBody(key)
    const properties: PlanPropertyStatus[] = []
    const NOT_IN_BODY = 'the action body does not mention it, and a helper or the route contract may'
    const mentions = (property: string, id: string): void => {
      const name = this.namesById.get(id) ?? id
      properties.push(body?.identifiers.includes(name) ? match(property, name) : unknown(property, name, NOT_IN_BODY))
    }

    // A mention is not a use, here as for the validator's own mount: a symbol can be
    // named by a leftover import or in a type position, and neither validates anything.
    // A readable body that validates with another schema or none is a `differ` (RFC 0030 §6).
    const contracts = this.routesTo(key)
    for (const field of CONTRACT_SEGMENTS) {
      const id = action[field]
      if (!id) continue
      const property = `${field} validator`
      const name = this.namesById.get(id) ?? id
      if (body?.validates.includes(name)) properties.push(match(property, name))
      else if (!isUnreadable(contracts) && contracts.some((route) => contractHolds(route, name))) properties.push(match(property, name, 'the route contract'))
      else if (body) properties.push(withholding(differ(property, name, body.validates.length > 0 ? body.validates.join(', ') : NO_VALIDATE_CALL)))
      else properties.push(unknown(property, name, 'the action body could not be read'))
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
   * Mounted when a mounted action validates with the symbol, or a mounted route's own
   * contract holds it. The contract half is object identity against the registered
   * definitions: a `body` key in an object nobody passes, in a function nobody calls
   * or in a branch nobody reaches registered nothing and is not evidence. Nor is a
   * bare mention, which only explains why this stayed unconfirmed.
   */
  private referenceMount(symbol: string, validator: PlanAppValidatorDetail | undefined): PlanAppMount {
    if (!this.detail) return { unconfirmed: NO_DETAIL.unreadable }
    const actions = this.section('actions')
    const routes = this.section('routes')
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

    for (const route of isUnreadable(routes) ? [] : routes) {
      if (!contractHolds(route, symbol)) continue
      const mount = this.routeMount(route)
      if (mount === 'mounted') return 'mounted'
      reasons.push(`the contract of ${route.name ?? `${route.method} ${route.path}`} holds it, and ${mount.unconfirmed}`)
    }

    for (const file of this.detail.routeFiles) {
      if (file.identifiers.includes(symbol)) mentions.push(`${file.file} mentions it, and no registered route contract holds it`)
    }

    if (reasons.length > 0) return { unconfirmed: reasons[0]! }
    if (validator?.unimported) {
      return { unconfirmed: `${validator.file} would not import, so no route contract could be matched to it (${validator.unimported})` }
    }
    return { unconfirmed: mentions[0] ?? 'no route contract holds it and no action body validates with it' }
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
      files: () => this.routeFiles(actual()),
    })
  }

  /** The entry file for an entry route; every routes file of its module for a module's, since nothing says which declared it. */
  private routeFiles(route: PlanAppRouteDetail): string[] {
    if (route.module === null) return route.file === undefined ? [] : [route.file]
    const prefix = `modules/${route.module}/`
    return (this.detail?.routeFiles ?? []).map((entry) => entry.file).filter((file) => file.startsWith(prefix))
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
      files: () => {
        const pages = this.section('pages')
        const file = isUnreadable(pages) ? undefined : pages.find((candidate) => candidate.id === view.page)?.file
        return file === undefined ? [] : [file]
      },
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
    const names: PlanAppNames = classes ? classes.map((entry) => ({ name: entry.className, module: entry.module })) : NO_DETAIL
    const noun = { plural: `${effect.kind} classes`, singular: effect.kind }
    const find = (name: string): Existence =>
      existsInScope(names, name, noun, effect.module, classes, (entry) => entry.className === name)
    return conclude({
      ...base,
      exists: find(effect.name),
      previous: previousOf(effect.change, find),
      files: () => classFiles(classes, effect.name, effect.module),
    })
  }
}
