/**
 * Reference checks for an implementation plan (RFC 0030 §2): the plan against
 * itself, and against the application as the scanners read it today.
 *
 * Results carry the id of the element they concern, so the rendered plan can show
 * each one beside its element. A section the scanners could not read
 * (`PlanAppUnreadable`) produces one warning naming the section and skips the
 * checks that would have read it: an unread scanner never passes and never fails.
 */

import { authMiddlewareVerdict } from '../audit'
import { describeMethod } from '../http-methods'
import { tableNameFor } from '../inflect'
import { check, type CheckResult, type CheckStatus } from '../check-result'
import {
  appNames,
  COLUMNS_ARE_A_LOWER_BOUND,
  isUnreadable,
  scopeName,
  type PlanAppName,
  type PlanAppNames,
  type PlanAppScope,
  type PlanAppState,
  type PlanAppTable,
  type PlanAppUnreadable,
} from './app-state'
import { listPlanReferences } from './references'
import {
  findDuplicatePlanIds,
  listPlanElements,
  type PlanAcceptance,
  type PlanAction,
  type PlanChange,
  type PlanColumn,
  type PlanDraft,
  type PlanElementSection,
  type PlanModel,
  type PlanFlowNode,
  type PlanRoute,
} from './schema'

export interface PlanCheckResult extends CheckResult {
  /** The plan element the finding belongs beside; absent on a plan-wide finding. */
  elementId?: string
  section?: PlanElementSection
}

/**
 * Matched before authentication, since `authorize` is an `auth` name too; authentication
 * itself goes through `guren audit`'s rule, so a plan and an audit cannot disagree.
 * `@guren/core` spells its own `authorize*`; an app's aliases match whole or to a
 * delimiter (`can`, `can:delete`), never as a prefix — `/^can/` also claimed
 * `cancelWindow`, and a name misread as authorization deletes the finding.
 */
const AUTHORIZATION_MIDDLEWARE = /^(?:authoriz|requireabilit)|^(?:can|gate|policy|ability)(?:[:.\-_]|$)/i

/** Which child change a parent's own change admits; `null` admits every kind. */
const CHILD_CHANGES_BY_PARENT: Record<PlanChange['kind'], ReadonlyArray<PlanChange['kind']> | null> = {
  add: ['add'],
  existing: ['existing'],
  drop: ['drop', 'existing'],
  alter: null,
  rename: null,
}

export function validatePlan(plan: PlanDraft, app: PlanAppState): PlanCheckResult[] {
  const results: PlanCheckResult[] = []
  const index = indexPlan(plan)

  checkDuplicateIds(plan, results)
  checkInternalReferences(plan, index, results)
  checkChangeConsistency(plan, results)
  checkAgainstApp(plan, app, results)
  checkInflectedNames(plan, results)
  checkRouteAuthorization(plan, index, results)
  checkDataMigrations(plan, results)
  checkAcceptanceCoverage(plan, index, results)
  checkApiOnlyViews(plan, app, results)

  return results
}

interface PlanIndex {
  byId: Map<string, PlanElementSection>
  actions: Map<string, PlanAction>
  /** Validator id → its field names, for the form fields that name one. */
  validatorFields: Map<string, Set<string>>
  /** Route id → the acceptance behaviours naming it. */
  acceptanceByRoute: Map<string, PlanAcceptance[]>
  /** Action id → the routes dispatching to it. */
  routesByAction: Map<string, PlanRoute[]>
}

function indexPlan(plan: PlanDraft): PlanIndex {
  const index: PlanIndex = {
    byId: new Map(listPlanElements(plan).map((ref) => [ref.id, ref.section])),
    actions: new Map(plan.controllers.flatMap((c) => c.actions.map((a) => [a.id, a] as const))),
    validatorFields: new Map(
      plan.validators.map((validator) => [validator.id, new Set(validator.fields.map((field) => field.name))]),
    ),
    acceptanceByRoute: new Map(),
    routesByAction: new Map(),
  }

  for (const task of plan.tasks) {
    for (const behaviour of task.acceptance) {
      push(index.acceptanceByRoute, behaviour.route, behaviour)
    }
  }
  for (const route of plan.routes) push(index.routesByAction, route.action, route)
  return index
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

/** The heading each key is grouped under; the renderer groups on `title`. */
const TITLES: Record<string, string> = {
  'plan:duplicate-id': 'Plan element ids',
  'plan:reference': 'Plan references',
  'plan:change-consistency': 'Plan change consistency',
  'plan:app-collision': 'Plan against the application',
  'plan:app-missing': 'Plan against the application',
  'plan:app-unjudged': 'Plan against the application',
  'plan:app-unreadable': 'Plan against the application',
  'plan:api-only-view': 'Plan against the application',
  'plan:inflection': 'Plan naming',
  'plan:route-authorization': 'Plan route authorization',
  'plan:route-body': 'Plan route validation',
  'plan:data-migration': 'Plan data migrations',
  'plan:rename-pair': 'Plan data migrations',
  'plan:acceptance': 'Plan acceptance coverage',
  'plan:flow-self-loop': 'Plan flows',
}

function finding(
  key: string,
  status: CheckStatus,
  message: string,
  extra: { elementId?: string; section?: PlanElementSection; suggestion?: string } = {},
): PlanCheckResult {
  const { suggestion, ...rest } = extra
  return { ...check(key, TITLES[key] ?? key, status, message, suggestion), ...rest }
}

function checkDuplicateIds(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const id of findDuplicatePlanIds(plan)) {
    results.push(
      finding('plan:duplicate-id', 'fail', `The id "${id}" is declared by more than one element.`, {
        elementId: id,
        suggestion: 'Ids share one namespace, since a revision addresses an element by id alone.',
      }),
    )
  }
}

/**
 * The section a step's kind commits it to. `null` is a kind deliberately free to name
 * any element: a `store` step may reasonably be a model or a resource, a `decision` a
 * validator or a policy. Total, so a new kind is a decision rather than a default.
 */
const FLOW_KIND_SECTIONS: Record<PlanFlowNode['kind'], PlanElementSection | null> = {
  route: 'routes',
  action: 'actions',
  page: 'views',
  actor: null,
  job: null,
  store: null,
  external: null,
  decision: null,
}

function checkInternalReferences(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  for (const reference of listPlanReferences(plan)) {
    // A flow step's expected section comes from its kind, and its finding belongs among
    // that flow's own step and edge findings, which `checkFlows` keeps in order.
    if (reference.field === 'flow.node') continue
    const where = { elementId: reference.from.id, section: reference.from.section }
    const found = index.byId.get(reference.to)
    if (reference.expected === null) {
      if (found === undefined) {
        results.push(
          finding('plan:reference', 'fail', `${reference.label} "${reference.to}", which no element declares.`, where),
        )
      }
      continue
    }
    if (found === reference.expected) continue
    const what = found === undefined ? 'no plan element' : `a ${found} element`
    results.push(
      finding(
        'plan:reference',
        'fail',
        `${reference.label} names "${reference.to}", which is ${what}; ${reference.expected} was expected.`,
        where,
      ),
    )
  }

  checkFlows(plan, index, results)
  checkFormFields(plan, index, results)
}

function checkFlows(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  for (const flow of plan.flows) {
    const fail = (message: string): void => {
      results.push(finding('plan:reference', 'fail', message, { elementId: flow.id, section: 'flows' }))
    }
    const nodes = new Set<string>()
    for (const node of flow.nodes) {
      // A step id is the flow's own, so a duplicate is only a duplicate here — and it
      // is what makes an edge end ambiguous.
      if (nodes.has(node.id)) fail(`Flow step "${node.id}" is declared twice, so an edge naming it is ambiguous.`)
      nodes.add(node.id)

      // A node need not name an element — an actor and an external service are not plan
      // elements — but one that does is a reference like any other.
      if (!node.element) continue
      const section = index.byId.get(node.element)
      if (section === undefined) {
        fail(`Flow step "${node.label}" names element "${node.element}", which the plan does not declare.`)
        continue
      }
      // Where a step's kind names a section, the element has to be in it: a step drawn
      // as a route and pointing at a page reads as a route in the picture.
      const expected = FLOW_KIND_SECTIONS[node.kind]
      if (expected === null || section === expected) continue
      fail(`Flow step "${node.label}" is a ${node.kind} step but names "${node.element}", which is a ${section} element.`)
    }
    for (const edge of flow.edges) {
      // Node ids are the flow's own, so an edge is checked against its own flow rather
      // than against the plan: two flows may both have a node called `start`. This runs
      // before the self-loop rule, or a mistyped `{ from: 'typo', to: 'typo' }` would be
      // reported as a loop on a step that does not exist.
      const missing = new Set<string>()
      for (const [end, id] of [['from', edge.from], ['to', edge.to]] as const) {
        if (nodes.has(id) || missing.has(id)) continue
        missing.add(id)
        fail(`A flow edge's "${end}" names "${id}", which is no step of this flow.`)
      }
      if (missing.size > 0 || edge.from !== edge.to) continue

      // The layout drops a self-loop, because a line from a box to itself draws nothing.
      // Saying so is the point: a plan that describes a retry on one step should not
      // find out from a picture that quietly left it out.
      results.push(
        finding('plan:flow-self-loop', 'warn', `Flow step "${edge.from}" loops to itself, which the diagram does not draw.`, {
          elementId: flow.id,
          section: 'flows',
        }),
      )
    }
  }
}

/** A form field names a field of its validator, which is a name rather than an id. */
function checkFormFields(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  for (const view of plan.views) {
    const fields = view.form && index.validatorFields.get(view.form.validator)
    if (!view.form || !fields) continue
    for (const field of view.form.fields) {
      if (fields.has(field.field)) continue
      results.push(
        finding(
          'plan:reference',
          'fail',
          `The form field "${field.field}" names no field of validator "${view.form.validator}".`,
          { elementId: view.id, section: 'views' },
        ),
      )
    }
  }
}

function checkChangeConsistency(plan: PlanDraft, results: PlanCheckResult[]): void {
  const report = (
    childId: string,
    section: PlanElementSection,
    noun: string,
    childKind: string,
    parentKind: string,
    parentLabel: string,
    allowed: ReadonlyArray<string>,
  ): void => {
    results.push(
      finding(
        'plan:change-consistency',
        'fail',
        `A "${childKind}" ${noun} sits under ${parentLabel}, whose change is "${parentKind}"; `
          + `only ${allowed.join(' or ')} is consistent there.`,
        { elementId: childId, section },
      ),
    )
  }

  for (const model of plan.models) {
    const allowed = CHILD_CHANGES_BY_PARENT[model.change.kind]
    if (!allowed) continue
    for (const column of model.columns) {
      if (allowed.includes(column.change.kind)) continue
      report(column.id, 'columns', 'column', column.change.kind, model.change.kind, `model "${model.name}"`, allowed)
    }
  }

  for (const controller of plan.controllers) {
    const allowed = CHILD_CHANGES_BY_PARENT[controller.change.kind]
    if (!allowed) continue
    for (const action of controller.actions) {
      if (allowed.includes(action.change.kind)) continue
      report(action.id, 'actions', 'action', action.change.kind, controller.change.kind, `controller "${controller.className}"`, allowed)
    }
  }
}

interface TargetCheck {
  id: string
  section: PlanElementSection
  /** What the element is called after the change. */
  current: string
  /** What it was called before a rename. */
  previous?: string
  kind: PlanChange['kind']
  noun: string
  /** What the name belongs to, e.g. ` of table "comments"`. */
  scope?: string
  /** The app root the plan puts the element in; absent where the section is not read per root. */
  root?: PlanAppScope
  /** The other app roots declaring a name, which is what makes an absence a placement. */
  elsewhere?: (name: string) => string[]
  /**
   * Where the name may not be taken at all, when that is wider than the root the element
   * sits in. Absent means the root's own names answer both questions.
   */
  collidesWith?: ReadonlyArray<PlanAppName>
  /**
   * Why an absent name is unconfirmed rather than missing, when the reader answers a
   * lower bound: the result warns and quotes this. A collision is positive evidence either way.
   */
  unconfirmedBecause?: string
}

function checkTarget(target: TargetCheck, existing: ReadonlyArray<string>, results: PlanCheckResult[]): void {
  const has = (name: string): boolean => existing.includes(name)
  const where = { elementId: target.id, section: target.section }
  const root = target.root === undefined ? 'this application' : scopeName(target.root)
  const taken = (name: string): PlanAppName | undefined => target.collidesWith?.find((entry) => entry.name === name)
  const collides = (name: string): boolean => (target.collidesWith ? taken(name) !== undefined : has(name))
  const collision = (name: string): void => {
    const owner = taken(name)
    const other = owner && owner.module !== (target.root ?? null) ? scopeName(owner.module) : undefined
    results.push(
      finding(
        'plan:app-collision',
        'fail',
        `The ${target.noun} "${name}"${target.scope ?? ''} already exists in ${other ?? root}.`
          + (other ? ` ${SHARED_SCHEMA}` : ''),
        where,
      ),
    )
  }
  const missing = (name: string): void => {
    const unconfirmed = target.unconfirmedBecause
    const others = target.elsewhere?.(name) ?? []
    results.push(
      finding(
        unconfirmed ? 'plan:app-unjudged' : 'plan:app-missing',
        unconfirmed ? 'warn' : 'fail',
        `The ${target.noun} "${name}"${target.scope ?? ''} was not found in ${root}, and the plan's change is "${target.kind}".`
          + (unconfirmed ? ` ${unconfirmed}` : '')
          + (others.length > 0 ? ` This application declares one in ${others.join(', ')}.` : ''),
        where,
      ),
    )
  }

  if (target.kind === 'add') {
    if (collides(target.current)) collision(target.current)
    return
  }
  if (target.kind === 'rename') {
    const previous = target.previous ?? target.current
    if (!has(previous)) missing(previous)
    else if (previous !== target.current && collides(target.current)) collision(target.current)
    return
  }
  if (!has(target.current)) missing(target.current)
}

/**
 * Why a table name is the application's rather than one app root's: `make:module` writes
 * `export * from '../modules/<name>/db/schema'` into the project's own `db/schema.ts`,
 * which is the file drizzle-kit reads, so two roots declaring one name are one SQL table
 * in one migration set and two identical exports of it.
 */
const SHARED_SCHEMA =
  "Every app root's schema is re-exported from the project's own db/schema.ts, so one name is one SQL table."

/**
 * A section as one app root sees it: the names declared there, and where else the same
 * name is declared. A plan element states its root with `module`, and a same-named
 * element in another root neither satisfies an `existing` nor collides with an `add`.
 */
function inRoot(
  entries: ReadonlyArray<PlanAppName>,
  module: string | undefined,
): { root: PlanAppScope; names: string[]; elsewhere: (name: string) => string[] } {
  const root = module ?? null
  return {
    root,
    names: entries.filter((entry) => entry.module === root).map((entry) => entry.name),
    elsewhere: (name) => [
      ...new Set(entries.filter((entry) => entry.name === name && entry.module !== root).map((entry) => scopeName(entry.module))),
    ],
  }
}

/**
 * Runs `use` against a readable section, or reports why it could not be judged. The
 * one way to reach a section's contents: a check that forgot the guard would skip
 * silently, and a warning nobody emitted is indistinguishable from a clean section.
 */
function withSection<T>(
  name: string,
  section: T[] | PlanAppUnreadable,
  results: PlanCheckResult[],
  use: (readable: T[]) => void,
  /** Elements this section would also have judged, which the section warning does not name. */
  orElse?: (reason: string) => void,
): void {
  if (!isUnreadable(section)) {
    use(section)
    return
  }
  results.push(
    finding(
      'plan:app-unreadable',
      'warn',
      `The application's ${name} could not be read (${section.unreadable}), so the plan's ${name} were neither confirmed nor refuted.`,
    ),
  )
  orElse?.(section.unreadable)
}

function checkAgainstApp(plan: PlanDraft, app: PlanAppState, results: PlanCheckResult[]): void {
  const named = <T extends { id: string; change: PlanChange }>(
    elements: ReadonlyArray<T>,
    options: {
      section: PlanElementSection
      appSection: string
      noun: string
      existing: PlanAppNames
      nameOf: (element: T) => string
      moduleOf?: (element: T) => string | undefined
    },
  ): void => checkNamedSection(elements, options, results)

  named(plan.models, { section: 'models', appSection: 'models', noun: 'model class', existing: app.models, nameOf: (m) => m.name, moduleOf: (m) => m.module })
  named(plan.controllers, { section: 'controllers', appSection: 'controllers', noun: 'controller class', existing: app.controllers, nameOf: (c) => c.className, moduleOf: (c) => c.module })
  named(plan.validators, { section: 'validators', appSection: 'validators', noun: 'validator', existing: app.validators, nameOf: (v) => v.name, moduleOf: (v) => v.module })
  named(plan.resources, { section: 'resources', appSection: 'resources', noun: 'resource', existing: app.resources, nameOf: (r) => r.name, moduleOf: (r) => r.module })
  named(plan.policies, { section: 'policies', appSection: 'policies', noun: 'policy', existing: app.policies, nameOf: (p) => p.name, moduleOf: (p) => p.module })
  // A module's pages are not colocated: they live in the project's own resources/js/pages
  // under the module's name, so the page id carries the root and the name does not.
  named(plan.views, { section: 'views', appSection: 'pages', noun: 'page', existing: app.pages, nameOf: (v) => v.page })

  withSection('tables', app.tables, results, (tables) => {
    const declared = tables.flatMap((table) => [
      { name: table.identifier, module: table.module },
      ...(table.tableName ? [{ name: table.tableName, module: table.module }] : []),
    ])
    for (const model of plan.models) {
      const { names, ...scoped } = inRoot(declared, model.module)
      checkTarget(
        {
          id: model.id,
          section: 'models',
          current: model.table,
          previous: model.tableRenamedFrom,
          // A class rename leaves the table alone; `tableRenamedFrom` is the only thing that moves it.
          kind: model.tableRenamedFrom ? 'rename' : model.change.kind === 'rename' ? 'existing' : model.change.kind,
          noun: 'table',
          ...scoped,
          collidesWith: declared,
        },
        names,
        results,
      )
      checkColumnsAgainstApp(model, tables, scoped.elsewhere, results)
    }
  },
  (reason) => {
    for (const model of plan.models) {
      if (model.change.kind === 'add' || model.columns.length === 0) continue
      reportUnjudgedColumns(model, `the application's schema could not be read (${reason})`, results)
    }
  })

  withSection('actions', app.actions, results, (actions) => {
    for (const controller of plan.controllers) {
      // An action's identity is `Class.action`, which is how a route names one; a
      // controller the plan renames is looked up under the name it has today.
      const className = renameFrom(controller.change) ?? controller.className
      // An action sits in the app root its controller does.
      const { names, ...scoped } = inRoot(actions, controller.module)
      for (const action of controller.actions) {
        const previousName = renameFrom(action.change)
        checkTarget(
          {
            id: action.id,
            section: 'actions',
            current: `${className}.${action.name}`,
            previous: previousName ? `${className}.${previousName}` : undefined,
            kind: action.change.kind,
            noun: 'action',
            ...scoped,
          },
          names,
          results,
        )
      }
    }
  })

  withSection('routes', app.routes, results, (routes) => {
    const names = routes.flatMap((route) => (route.name ? [route.name] : []))
    const endpoints = new Set(routes.map((route) => `${route.method.toUpperCase()} ${route.path}`))
    for (const route of plan.routes) {
      // A route's name is checked as its identity; its path is not, since an `alter`
      // may move the path while keeping the name.
      checkTarget(
        { id: route.id, section: 'routes', current: route.name, previous: renameFrom(route.change), kind: route.change.kind, noun: 'route name' },
        names,
        results,
      )
      if (route.change.kind !== 'add') continue
      if (!endpoints.has(`${route.method} ${route.path}`)) continue
      results.push(
        finding('plan:app-collision', 'fail', `The route "${route.method} ${route.path}" is already registered by this application.`, {
          elementId: route.id,
          section: 'routes',
        }),
      )
    }
  })
}

/**
 * A section whose elements are each checked by one name, against one list of app
 * names. `appSection` names the application's list rather than the plan's, since a
 * plan's `views` are judged against the application's `pages`.
 */
function checkNamedSection<T extends { id: string; change: PlanChange }>(
  elements: ReadonlyArray<T>,
  options: {
    section: PlanElementSection
    appSection: string
    noun: string
    existing: PlanAppNames
    nameOf: (element: T) => string
    /** The app root the plan puts each element in; absent where the section is not read per root. */
    moduleOf?: (element: T) => string | undefined
  },
  results: PlanCheckResult[],
): void {
  const { section, noun, nameOf, moduleOf } = options
  withSection(options.appSection, options.existing, results, (entries) => {
    for (const element of elements) {
      const { names, ...scoped } = moduleOf
        ? inRoot(entries, moduleOf(element))
        : { names: appNames(entries), root: undefined, elsewhere: undefined }
      checkTarget(
        { id: element.id, section, current: nameOf(element), previous: renameFrom(element.change), kind: element.change.kind, noun, ...scoped },
        names,
        results,
      )
    }
  })
}

function checkColumnsAgainstApp(
  model: PlanModel,
  tables: ReadonlyArray<PlanAppTable>,
  elsewhere: (name: string) => string[],
  results: PlanCheckResult[],
): void {
  if (model.change.kind === 'add') return
  const lookup = model.tableRenamedFrom ?? model.table
  const table = tables.find(
    (candidate) =>
      candidate.module === (model.module ?? null) && (candidate.identifier === lookup || candidate.tableName === lookup),
  )
  if (!table) {
    if (model.columns.length > 0) {
      const other = elsewhere(lookup)
      reportUnjudgedColumns(
        model,
        `table "${lookup}" was not found in ${scopeName(model.module ?? null)}`
          + (other.length > 0 ? `, though this application declares one in ${other.join(', ')}` : ''),
        results,
      )
    }
    return
  }
  for (const column of model.columns) {
    checkTarget(
      {
        id: column.id,
        section: 'columns',
        current: column.name,
        previous: renameFrom(column.change),
        kind: column.change.kind,
        noun: 'column',
        scope: ` of table "${table.tableName ?? table.identifier}"`,
        unconfirmedBecause: COLUMNS_ARE_A_LOWER_BOUND,
      },
      table.columns,
      results,
    )
  }
}

/**
 * Columns the checks did not reach. Without it they are skipped in silence, which on
 * the rendered page is indistinguishable from a column that was checked and passed.
 */
function reportUnjudgedColumns(model: PlanModel, because: string, results: PlanCheckResult[]): void {
  results.push(
    finding(
      'plan:app-unjudged',
      'warn',
      `The ${model.columns.length} planned column(s) of "${model.name}" were neither confirmed nor refuted: ${because}.`,
      { elementId: model.id, section: 'models' },
    ),
  )
}

function renameFrom(change: PlanChange): string | undefined {
  return change.kind === 'rename' ? change.from : undefined
}

function checkInflectedNames(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const model of plan.models) {
    if (model.change.kind !== 'add') continue
    const expected = tableNameFor(model.name)
    if (model.table === expected) continue
    results.push(
      finding(
        'plan:inflection',
        'warn',
        `Model "${model.name}" declares table "${model.table}"; Guren's own inflection derives "${expected}".`,
        {
          elementId: model.id,
          section: 'models',
          suggestion: 'A table the scaffolders do not derive has to be written by hand everywhere it is named.',
        },
      ),
    )
  }
}

function classifyMiddleware(names: ReadonlyArray<string>): { authenticates: boolean; authorizes: boolean } {
  const rest: string[] = []
  let authorizes = false
  for (const name of names) {
    if (AUTHORIZATION_MIDDLEWARE.test(name)) authorizes = true
    else rest.push(name)
  }
  return { authenticates: authMiddlewareVerdict({ middlewareNames: rest, capabilities: undefined }) !== 'none', authorizes }
}

function checkRouteAuthorization(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  for (const route of plan.routes) {
    if (route.change.kind !== 'add' && route.change.kind !== 'alter') continue
    const action = index.actions.get(route.action)
    const method = describeMethod(route.method)
    const { authenticates, authorizes } = classifyMiddleware([...route.middleware, ...(action?.authorization.middleware ?? [])])

    if (!method.safe && authenticates && !authorizes && !action?.authorization.policy) {
      results.push(
        finding(
          'plan:route-authorization',
          'warn',
          `"${route.name}" mutates and requires authentication, but names no policy or authorization middleware.`,
          {
            elementId: route.id,
            section: 'routes',
            suggestion: 'Authentication says who is calling; it does not say they may.',
          },
        ),
      )
    }

    if (method.bodyCarrying && action && !action.body) {
      results.push(
        finding(
          'plan:route-body',
          'warn',
          `"${route.name}" carries a ${route.method} body, but action "${action.name}" names no body validator.`,
          { elementId: route.id, section: 'routes' },
        ),
      )
    }
  }
}

const MIGRATION_ANSWER = 'Answer every time; { "kind": "none", "reason": ... } is an accepted answer.'

function checkDataMigrations(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const model of plan.models) {
    // A model `alter` is expressed by its columns, which carry their own answer; only a
    // table that is renamed or dropped is a data migration of the model itself.
    const movesTable = model.change.kind === 'drop' || model.tableRenamedFrom !== undefined
    if (movesTable && !model.dataMigration) {
      results.push(
        finding(
          'plan:data-migration',
          'fail',
          `Model "${model.name}" ${model.change.kind === 'drop' ? 'drops' : 'renames'} table "${model.tableRenamedFrom ?? model.table}" and states no dataMigration.`,
          { elementId: model.id, section: 'models', suggestion: MIGRATION_ANSWER },
        ),
      )
    }

    if (model.change.kind !== 'add') {
      for (const column of model.columns) {
        if (column.change.kind === 'existing' || column.change.kind === 'add') continue
        if (column.dataMigration) continue
        results.push(
          finding(
            'plan:data-migration',
            'fail',
            `Column "${column.name}" of "${model.name}" is a "${column.change.kind}" on an existing table and states no dataMigration.`,
            { elementId: column.id, section: 'columns', suggestion: MIGRATION_ANSWER },
          ),
        )
      }
    }

    reportRenamePair(model, results)
  }
}

/**
 * Exactly one dropped and one added column of the same type on one table. A looser
 * rule fires once per pair and gets suppressed wholesale, which is worse than silence.
 */
function reportRenamePair(model: PlanModel, results: PlanCheckResult[]): void {
  const dropped = model.columns.filter((column) => column.change.kind === 'drop')
  const added = model.columns.filter((column) => column.change.kind === 'add')
  if (dropped.length !== 1 || added.length !== 1) return
  const from = dropped[0] as PlanColumn
  const to = added[0] as PlanColumn
  if (from.type !== to.type) return
  results.push(
    finding(
      'plan:rename-pair',
      'warn',
      `"${model.name}" drops "${from.name}" and adds "${to.name}" with the same type, which reads as a rename.`,
      { elementId: to.id, section: 'columns', suggestion: 'A rename keeps the rows; a drop and an add do not.' },
    ),
  )
}

function checkAcceptanceCoverage(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  const behavioursOf = (routeId: string): PlanAcceptance[] => index.acceptanceByRoute.get(routeId) ?? []

  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      if (action.change.kind !== 'alter') continue
      const routes = index.routesByAction.get(action.id) ?? []
      // A behaviour's `route` is a plan route id, so an action the plan states no
      // route for cannot be covered at all — a different fix from an uncovered route.
      if (routes.length === 0) {
        results.push(
          finding(
            'plan:acceptance',
            'fail',
            `Action "${action.name}" is altered, but the plan states no route reaching it, so no acceptance behaviour can name one.`,
            {
              elementId: action.id,
              section: 'actions',
              suggestion: 'Restate the route this action serves as { "kind": "existing" }, then give it an acceptance behaviour.',
            },
          ),
        )
        continue
      }
      if (routes.some((route) => behavioursOf(route.id).length > 0)) continue
      results.push(
        finding(
          'plan:acceptance',
          'fail',
          `Action "${action.name}" is altered, but no acceptance behaviour names any of its routes.`,
          {
            elementId: action.id,
            section: 'actions',
            suggestion: 'An altered action may change no shape a scanner reads, so its behaviours are the only evidence it works.',
          },
        ),
      )
    }
  }

  for (const route of plan.routes) {
    if (route.change.kind !== 'add' && route.change.kind !== 'alter') continue
    const action = index.actions.get(route.action)
    if (!action) continue
    const kinds = new Set(behavioursOf(route.id).map((behaviour) => behaviour.kind))
    const { authenticates } = classifyMiddleware([...route.middleware, ...action.authorization.middleware])
    const wanted: Array<[boolean, PlanAcceptance['kind'], string]> = [
      [Boolean(action.body ?? action.params ?? action.query), 'validation', 'names a validator'],
      [authenticates, 'unauthenticated', 'requires authentication'],
      [action.authorization.policy !== undefined, 'forbidden', 'enforces a policy'],
    ]
    for (const [applies, kind, because] of wanted) {
      if (!applies || kinds.has(kind)) continue
      results.push(
        finding('plan:acceptance', 'warn', `"${route.name}" ${because}, but no acceptance behaviour of kind "${kind}" names it.`, {
          elementId: route.id,
          section: 'routes',
        }),
      )
    }
  }
}

function checkApiOnlyViews(plan: PlanDraft, app: PlanAppState, results: PlanCheckResult[]): void {
  if (!app.apiOnly) return
  for (const view of plan.views) {
    results.push(
      finding('plan:api-only-view', 'fail', `This application is API-only, and "${view.page}" is an Inertia page it cannot render.`, {
        elementId: view.id,
        section: 'views',
      }),
    )
  }
}
