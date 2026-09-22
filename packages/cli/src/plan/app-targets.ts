/**
 * Which name each plan element is judged by against the application (RFC 0030 §2), as
 * one derivation. The §2 checks in `validate.ts` and the §4 freshness stamp both read it:
 * a stamp that hashed a name the checks never look up would call an element fresh while
 * the checks judged another one, which is the drift `references.ts` exists to prevent.
 */

import type { PlanChange, PlanController, PlanDraft, PlanElementSection, PlanModel, PlanRoute } from './schema'

/** The `PlanAppState` sections {@link namedTargets} reads, in the order their findings are reported. */
export const NAMED_APP_SECTIONS = ['models', 'controllers', 'validators', 'resources', 'policies', 'pages'] as const

/** The `PlanAppState` section a target is looked up in. */
export type PlanAppTargetSection = (typeof NAMED_APP_SECTIONS)[number] | 'tables' | 'actions' | 'routes'

export interface PlanAppTarget {
  id: string
  section: PlanElementSection
  appSection: PlanAppTargetSection
  /** What the element is called after the change. */
  current: string
  /** What it was called before a rename. */
  previous?: string
  kind: PlanChange['kind']
  noun: string
  /** Whether the section is judged per app root; `module` is then the root the plan names. */
  perRoot: boolean
  module?: string
  /** A child of an element the plan drops, which is gone once the drop lands whatever its own change says. */
  parentDropped?: true
  /** An action under a controller the plan renames: the class it is found under once the rename is done. */
  renamedClass?: { from: string; to: string }
  /** A column: the table it is looked up in, in its model's app root. */
  table?: { lookup: string; current: string }
  /** A route: the endpoint the plan gives it, which an `add` must not find already registered. */
  endpoint?: string
}

/** How an endpoint is compared everywhere: `GET /posts`. */
export function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

function renameFrom(change: PlanChange): string | undefined {
  return change.kind === 'rename' ? change.from : undefined
}

type Named = { id: string; change: PlanChange; module?: string }

function named<T extends Named>(
  elements: ReadonlyArray<T>,
  section: PlanElementSection,
  appSection: PlanAppTargetSection,
  noun: string,
  nameOf: (element: T) => string,
  perRoot = true,
): PlanAppTarget[] {
  return elements.map((element) => ({
    id: element.id,
    section,
    appSection,
    current: nameOf(element),
    previous: renameFrom(element.change),
    kind: element.change.kind,
    noun,
    perRoot,
    ...(perRoot ? { module: element.module } : {}),
  }))
}

/** The class-named sections, in {@link NAMED_APP_SECTIONS} order. */
export function namedTargets(plan: PlanDraft): PlanAppTarget[] {
  return [
    ...named(plan.models, 'models', 'models', 'model class', (m) => m.name),
    ...named(plan.controllers, 'controllers', 'controllers', 'controller class', (c) => c.className),
    ...named(plan.validators, 'validators', 'validators', 'validator', (v) => v.name),
    ...named(plan.resources, 'resources', 'resources', 'resource', (r) => r.name),
    ...named(plan.policies, 'policies', 'policies', 'policy', (p) => p.name),
    // A module's pages are not colocated: they live in the project's own resources/js/pages
    // under the module's name, so the page id carries the root and the name does not.
    ...named(plan.views, 'views', 'pages', 'page', (v) => v.page, false),
  ]
}

export function tableTarget(model: PlanModel): PlanAppTarget {
  return {
    id: model.id,
    section: 'models',
    appSection: 'tables',
    current: model.table,
    previous: model.tableRenamedFrom,
    // A class rename leaves the table alone; `tableRenamedFrom` is the only thing that moves it.
    kind: model.tableRenamedFrom ? 'rename' : model.change.kind === 'rename' ? 'existing' : model.change.kind,
    noun: 'table',
    perRoot: true,
    module: model.module,
  }
}

/** Empty for an added model, whose columns no table in the application can hold yet. */
export function columnTargets(model: PlanModel): PlanAppTarget[] {
  if (model.change.kind === 'add') return []
  const table = { lookup: model.tableRenamedFrom ?? model.table, current: model.table }
  return model.columns.map((column) => ({
    id: column.id,
    section: 'columns',
    appSection: 'tables',
    current: column.name,
    previous: renameFrom(column.change),
    kind: column.change.kind,
    noun: 'column',
    perRoot: true,
    module: model.module,
    table,
    ...(model.change.kind === 'drop' ? { parentDropped: true as const } : {}),
  }))
}

/**
 * An action's identity is `Class.action`, which is how a route names one; a controller
 * the plan renames is looked up under the name it has today. It sits in its controller's root.
 */
export function actionTargets(controller: PlanController): PlanAppTarget[] {
  const today = renameFrom(controller.change)
  const className = today ?? controller.className
  return controller.actions.map((action) => {
    const previousName = renameFrom(action.change)
    return {
      id: action.id,
      section: 'actions',
      appSection: 'actions',
      current: `${className}.${action.name}`,
      previous: previousName ? `${className}.${previousName}` : undefined,
      kind: action.change.kind,
      noun: 'action',
      perRoot: true,
      module: controller.module,
      ...(today ? { renamedClass: { from: today, to: controller.className } } : {}),
      ...(controller.change.kind === 'drop' ? { parentDropped: true as const } : {}),
    }
  })
}

/** A route is judged by its name; its path only as a collision, since an `alter` may move it. */
export function routeTarget(route: PlanRoute): PlanAppTarget {
  return {
    id: route.id,
    section: 'routes',
    appSection: 'routes',
    current: route.name,
    previous: renameFrom(route.change),
    kind: route.change.kind,
    noun: 'route name',
    perRoot: false,
    endpoint: endpointKey(route.method, route.path),
  }
}

/** Every target, in the order the §2 checks judge them. A model contributes two: its class and its table. */
export function listPlanAppTargets(plan: PlanDraft): PlanAppTarget[] {
  return [
    ...namedTargets(plan),
    ...plan.models.flatMap((model) => [tableTarget(model), ...columnTargets(model)]),
    ...plan.controllers.flatMap(actionTargets),
    ...plan.routes.map(routeTarget),
  ]
}
