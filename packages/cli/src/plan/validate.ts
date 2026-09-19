/**
 * Reference checks for an implementation plan (RFC 0030 §2): the plan against
 * itself, and against the application as the scanners read it today.
 *
 * Results carry the id of the element they concern, so the rendered plan can show
 * each one beside its element. A section the scanners could not read
 * (`PlanAppUnreadable`) produces one warning naming the section and skips the
 * checks that would have read it: an unread scanner never passes and never fails.
 */

import { describeMethod } from '../http-methods'
import { tableNameFor } from '../inflect'
import type { CheckResult, CheckStatus } from '../check-result'
import { isUnreadable, type PlanAppState, type PlanAppNames } from './app-state'
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
  type PlanRoute,
} from './schema'

export interface PlanCheckResult extends CheckResult {
  /** The plan element the finding belongs beside; absent on a plan-wide finding. */
  elementId?: string
  section?: PlanElementSection
}

/** Middleware that authorizes is tested first: `authorize` starts with `auth` too. */
const AUTHORIZATION_MIDDLEWARE = /^(can|authoriz|policy|gate|requireabilit)/i
const AUTHENTICATION_MIDDLEWARE = /^(auth|requireauth|signedin|requiresignedin)/i

/** Which column changes a model's own change admits. An `alter` model admits every kind. */
const COLUMN_CHANGES_BY_MODEL: Record<PlanChange['kind'], ReadonlyArray<PlanChange['kind']> | null> = {
  add: ['add'],
  existing: ['existing'],
  drop: ['drop', 'existing'],
  alter: null,
  rename: null,
}

const ACTION_CHANGES_BY_CONTROLLER = COLUMN_CHANGES_BY_MODEL

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
  models: Map<string, PlanModel>
  actions: Map<string, PlanAction>
  routes: Map<string, PlanRoute>
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
    models: new Map(plan.models.map((model) => [model.id, model])),
    actions: new Map(plan.controllers.flatMap((c) => c.actions.map((a) => [a.id, a] as const))),
    routes: new Map(plan.routes.map((route) => [route.id, route])),
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

function result(
  key: string,
  title: string,
  status: CheckStatus,
  message: string,
  elementId: string,
  section: PlanElementSection,
  suggestion?: string,
): PlanCheckResult {
  return { key, title, status, message, suggestion, elementId, section }
}

function checkDuplicateIds(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const id of findDuplicatePlanIds(plan)) {
    results.push({
      key: 'plan:duplicate-id',
      title: 'Plan element ids',
      status: 'fail',
      message: `The id "${id}" is declared by more than one element.`,
      suggestion: 'Ids share one namespace, since a revision addresses an element by id alone.',
      elementId: id,
    })
  }
}

function checkInternalReferences(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  const expect = (
    from: string,
    section: PlanElementSection,
    target: string,
    expected: PlanElementSection | PlanElementSection[],
    label: string,
  ): void => {
    const sections = Array.isArray(expected) ? expected : [expected]
    const found = index.byId.get(target)
    if (found !== undefined && sections.includes(found)) return
    const what = found === undefined ? 'no plan element' : `a ${found} element`
    results.push(
      result(
        'plan:reference',
        'Plan references',
        'fail',
        `${label} names "${target}", which is ${what}; ${sections.join(' or ')} was expected.`,
        from,
        section,
      ),
    )
  }

  for (const model of plan.models) {
    for (const relationship of model.relationships) {
      expect(model.id, 'models', relationship.target, 'models', `Relationship "${relationship.name}"`)
    }
    for (const column of model.columns) {
      if (column.references) {
        expect(column.id, 'columns', column.references.model, 'models', `The foreign key on "${column.name}"`)
      }
    }
  }

  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      for (const [field, id] of [['params', action.params], ['query', action.query], ['body', action.body]] as const) {
        if (id) expect(action.id, 'actions', id, 'validators', `The ${field} validator`)
      }
      if (action.authorization.policy) {
        expect(action.id, 'actions', action.authorization.policy.id, 'policies', 'The policy')
      }
      if (action.response.kind === 'inertia') {
        expect(action.id, 'actions', action.response.view, 'views', 'The response page')
      }
      if (action.response.kind === 'resource') {
        expect(action.id, 'actions', action.response.resource, 'resources', 'The response resource')
      }
    }
  }

  for (const route of plan.routes) {
    expect(route.id, 'routes', route.action, 'actions', 'The route action')
    for (const binding of route.bind) {
      expect(route.id, 'routes', binding.model, 'models', `The binding for ":${binding.param}"`)
    }
  }

  for (const view of plan.views) {
    for (const prop of view.props) {
      if (prop.resource) expect(view.id, 'views', prop.resource, 'resources', `The resource of prop "${prop.name}"`)
    }
    for (const action of view.actions) {
      expect(view.id, 'views', action.route, 'routes', `The route of action "${action.label}"`)
    }
    if (!view.form) continue
    expect(view.id, 'views', view.form.validator, 'validators', 'The form validator')
    expect(view.id, 'views', view.form.submitsTo, 'routes', 'The form target')
    const fields = index.validatorFields.get(view.form.validator)
    if (!fields) continue
    for (const field of view.form.fields) {
      if (fields.has(field.field)) continue
      results.push(
        result(
          'plan:reference',
          'Plan references',
          'fail',
          `The form field "${field.field}" names no field of validator "${view.form.validator}".`,
          view.id,
          'views',
        ),
      )
    }
  }

  for (const resource of plan.resources) expect(resource.id, 'resources', resource.model, 'models', 'The resource model')
  for (const policy of plan.policies) expect(policy.id, 'policies', policy.model, 'models', 'The policy model')

  for (const question of plan.questions) {
    for (const affected of question.affects) {
      if (index.byId.has(affected)) continue
      results.push(
        result(
          'plan:reference',
          'Plan references',
          'fail',
          `The question affects "${affected}", which no element declares.`,
          question.id,
          'questions',
        ),
      )
    }
  }

  for (const task of plan.tasks) {
    for (const covered of task.covers) {
      if (index.byId.has(covered)) continue
      results.push(
        result('plan:reference', 'Plan references', 'fail', `The task covers "${covered}", which no element declares.`, task.id, 'tasks'),
      )
    }
    for (const behaviour of task.acceptance) {
      expect(behaviour.id, 'acceptance', behaviour.route, 'routes', 'The behaviour route')
      if (behaviour.expect.inertia) {
        expect(behaviour.id, 'acceptance', behaviour.expect.inertia, 'views', 'The expected page')
      }
    }
  }
}

function checkChangeConsistency(plan: PlanDraft, results: PlanCheckResult[]): void {
  const report = (
    childId: string,
    section: PlanElementSection,
    childKind: string,
    parentKind: string,
    parentLabel: string,
    allowed: ReadonlyArray<string>,
  ): void => {
    results.push(
      result(
        'plan:change-consistency',
        'Plan change consistency',
        'fail',
        `A "${childKind}" ${section === 'columns' ? 'column' : 'action'} sits under ${parentLabel}, whose change is "${parentKind}"; `
          + `only ${allowed.join(' or ')} is consistent there.`,
        childId,
        section,
      ),
    )
  }

  for (const model of plan.models) {
    const allowed = COLUMN_CHANGES_BY_MODEL[model.change.kind]
    if (!allowed) continue
    for (const column of model.columns) {
      if (allowed.includes(column.change.kind)) continue
      report(column.id, 'columns', column.change.kind, model.change.kind, `model "${model.name}"`, allowed)
    }
  }

  for (const controller of plan.controllers) {
    const allowed = ACTION_CHANGES_BY_CONTROLLER[controller.change.kind]
    if (!allowed) continue
    for (const action of controller.actions) {
      if (allowed.includes(action.change.kind)) continue
      report(action.id, 'actions', action.change.kind, controller.change.kind, `controller "${controller.className}"`, allowed)
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
}

function checkTarget(target: TargetCheck, existing: ReadonlyArray<string>, results: PlanCheckResult[]): void {
  const has = (name: string): boolean => existing.includes(name)
  const collision = (name: string): void => {
    results.push(
      result(
        'plan:app-collision',
        'Plan against the application',
        'fail',
        `The ${target.noun} "${name}"${target.scope ?? ''} already exists in this application.`,
        target.id,
        target.section,
      ),
    )
  }
  const missing = (name: string): void => {
    results.push(
      result(
        'plan:app-missing',
        'Plan against the application',
        'fail',
        `The ${target.noun} "${name}"${target.scope ?? ''} does not exist in this application, but the plan's change is "${target.kind}".`,
        target.id,
        target.section,
      ),
    )
  }

  if (target.kind === 'add') {
    if (has(target.current)) collision(target.current)
    return
  }
  if (target.kind === 'rename') {
    const previous = target.previous ?? target.current
    if (!has(previous)) missing(previous)
    else if (previous !== target.current && has(target.current)) collision(target.current)
    return
  }
  if (!has(target.current)) missing(target.current)
}

function checkAgainstApp(plan: PlanDraft, app: PlanAppState, results: PlanCheckResult[]): void {
  reportUnreadable(app, results)

  if (!isUnreadable(app.models)) {
    for (const model of plan.models) {
      checkTarget(
        { id: model.id, section: 'models', current: model.name, previous: renameFrom(model.change), kind: model.change.kind, noun: 'model class' },
        app.models,
        results,
      )
    }
  }

  if (!isUnreadable(app.tables)) {
    const tableNames = app.tables.flatMap((table) => [table.identifier, ...(table.tableName ? [table.tableName] : [])])
    for (const model of plan.models) {
      checkTarget(
        {
          id: model.id,
          section: 'models',
          current: model.table,
          previous: model.tableRenamedFrom,
          // A class rename leaves the table alone; `tableRenamedFrom` is the only thing that moves it.
          kind: model.tableRenamedFrom ? 'rename' : model.change.kind === 'rename' ? 'existing' : model.change.kind,
          noun: 'table',
        },
        tableNames,
        results,
      )
      checkColumnsAgainstApp(model, app.tables, results)
    }
  }

  if (!isUnreadable(app.controllers)) {
    for (const controller of plan.controllers) {
      checkTarget(
        {
          id: controller.id,
          section: 'controllers',
          current: controller.className,
          previous: renameFrom(controller.change),
          kind: controller.change.kind,
          noun: 'controller class',
        },
        app.controllers,
        results,
      )
    }
  }

  checkNamedSection(plan.resources, 'resources', 'resource', app.resources, results)
  checkNamedSection(plan.policies, 'policies', 'policy', app.policies, results)

  if (!isUnreadable(app.pages)) {
    for (const view of plan.views) {
      checkTarget(
        { id: view.id, section: 'views', current: view.page, previous: renameFrom(view.change), kind: view.change.kind, noun: 'page' },
        app.pages,
        results,
      )
    }
  }

  if (!isUnreadable(app.routes)) {
    const names = app.routes.flatMap((route) => (route.name ? [route.name] : []))
    const endpoints = new Set(app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`))
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
        result(
          'plan:app-collision',
          'Plan against the application',
          'fail',
          `The route "${route.method} ${route.path}" is already registered by this application.`,
          route.id,
          'routes',
        ),
      )
    }
  }
}

function checkNamedSection(
  elements: ReadonlyArray<{ id: string; name: string; change: PlanChange }>,
  section: PlanElementSection,
  noun: string,
  existing: PlanAppNames,
  results: PlanCheckResult[],
): void {
  if (isUnreadable(existing)) return
  for (const element of elements) {
    checkTarget(
      { id: element.id, section, current: element.name, previous: renameFrom(element.change), kind: element.change.kind, noun },
      existing,
      results,
    )
  }
}

function checkColumnsAgainstApp(model: PlanModel, tables: ReadonlyArray<{ identifier: string; tableName?: string; columns: string[] }>, results: PlanCheckResult[]): void {
  if (model.change.kind === 'add') return
  const lookup = model.tableRenamedFrom ?? model.table
  const table = tables.find((candidate) => candidate.identifier === lookup || candidate.tableName === lookup)
  if (!table) return
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
      },
      table.columns,
      results,
    )
  }
}

function renameFrom(change: PlanChange): string | undefined {
  return change.kind === 'rename' ? change.from : undefined
}

function reportUnreadable(app: PlanAppState, results: PlanCheckResult[]): void {
  const sections: Array<[string, PlanAppNames | PlanAppState['routes'] | PlanAppState['tables']]> = [
    ['models', app.models],
    ['controllers', app.controllers],
    ['resources', app.resources],
    ['policies', app.policies],
    ['pages', app.pages],
    ['validators', app.validators],
    ['routes', app.routes],
    ['tables', app.tables],
  ]
  for (const [name, section] of sections) {
    if (!isUnreadable(section)) continue
    results.push({
      key: 'plan:app-unreadable',
      title: 'Plan against the application',
      status: 'warn',
      message: `The application's ${name} could not be read (${section.unreadable}), so the plan's ${name} were neither confirmed nor refuted.`,
    })
  }
}

function checkInflectedNames(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const model of plan.models) {
    if (model.change.kind !== 'add') continue
    const expected = tableNameFor(model.name)
    if (model.table === expected) continue
    results.push(
      result(
        'plan:inflection',
        'Plan naming',
        'warn',
        `Model "${model.name}" declares table "${model.table}"; Guren's own inflection derives "${expected}".`,
        model.id,
        'models',
        'A table the scaffolders do not derive has to be written by hand everywhere it is named.',
      ),
    )
  }
}

function classifyMiddleware(names: ReadonlyArray<string>): { authenticates: boolean; authorizes: boolean } {
  let authenticates = false
  let authorizes = false
  for (const name of names) {
    if (AUTHORIZATION_MIDDLEWARE.test(name)) authorizes = true
    else if (AUTHENTICATION_MIDDLEWARE.test(name)) authenticates = true
  }
  return { authenticates, authorizes }
}

function checkRouteAuthorization(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  for (const route of plan.routes) {
    if (route.change.kind !== 'add' && route.change.kind !== 'alter') continue
    const action = index.actions.get(route.action)
    const method = describeMethod(route.method)
    const { authenticates, authorizes } = classifyMiddleware([...route.middleware, ...(action?.authorization.middleware ?? [])])

    if (!method.safe && authenticates && !authorizes && !action?.authorization.policy) {
      results.push(
        result(
          'plan:route-authorization',
          'Plan route authorization',
          'warn',
          `"${route.name}" mutates and requires authentication, but names no policy or authorization middleware.`,
          route.id,
          'routes',
          'Authentication says who is calling; it does not say they may.',
        ),
      )
    }

    if (method.bodyCarrying && action && !action.body) {
      results.push(
        result(
          'plan:route-body',
          'Plan route validation',
          'warn',
          `"${route.name}" carries a ${route.method} body, but action "${action.name}" names no body validator.`,
          route.id,
          'routes',
        ),
      )
    }
  }
}

function checkDataMigrations(plan: PlanDraft, results: PlanCheckResult[]): void {
  for (const model of plan.models) {
    // A model `alter` is expressed by its columns, which carry their own answer; only a
    // table that is renamed or dropped is a data migration of the model itself.
    const movesTable = model.change.kind === 'drop' || model.tableRenamedFrom !== undefined
    if (movesTable && !model.dataMigration) {
      results.push(
        result(
          'plan:data-migration',
          'Plan data migrations',
          'fail',
          `Model "${model.name}" ${model.change.kind === 'drop' ? 'drops' : 'renames'} table "${model.tableRenamedFrom ?? model.table}" and states no dataMigration.`,
          model.id,
          'models',
          'Answer every time; { "kind": "none", "reason": ... } is an accepted answer.',
        ),
      )
    }

    if (model.change.kind !== 'add') {
      for (const column of model.columns) {
        if (column.change.kind === 'existing' || column.change.kind === 'add') continue
        if (column.dataMigration) continue
        results.push(
          result(
            'plan:data-migration',
            'Plan data migrations',
            'fail',
            `Column "${column.name}" of "${model.name}" is a "${column.change.kind}" on an existing table and states no dataMigration.`,
            column.id,
            'columns',
            'Answer every time; { "kind": "none", "reason": ... } is an accepted answer.',
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
    result(
      'plan:rename-pair',
      'Plan data migrations',
      'warn',
      `"${model.name}" drops "${from.name}" and adds "${to.name}" with the same type, which reads as a rename.`,
      to.id,
      'columns',
      'A rename keeps the rows; a drop and an add do not.',
    ),
  )
}

function checkAcceptanceCoverage(plan: PlanDraft, index: PlanIndex, results: PlanCheckResult[]): void {
  const behavioursOf = (routeId: string): PlanAcceptance[] => index.acceptanceByRoute.get(routeId) ?? []

  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      if (action.change.kind !== 'alter') continue
      const routes = index.routesByAction.get(action.id) ?? []
      if (routes.some((route) => behavioursOf(route.id).length > 0)) continue
      results.push(
        result(
          'plan:acceptance',
          'Plan acceptance coverage',
          'fail',
          `Action "${action.name}" is altered, but no acceptance behaviour names any of its routes.`,
          action.id,
          'actions',
          'An altered action may change no shape a scanner reads, so its behaviours are the only evidence it works.',
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
        result(
          'plan:acceptance',
          'Plan acceptance coverage',
          'warn',
          `"${route.name}" ${because}, but no acceptance behaviour of kind "${kind}" names it.`,
          route.id,
          'routes',
        ),
      )
    }
  }
}

function checkApiOnlyViews(plan: PlanDraft, app: PlanAppState, results: PlanCheckResult[]): void {
  if (!app.apiOnly) return
  for (const view of plan.views) {
    results.push(
      result(
        'plan:api-only-view',
        'Plan against the application',
        'fail',
        `This application is API-only, and "${view.page}" is an Inertia page it cannot render.`,
        view.id,
        'views',
      ),
    )
  }
}
