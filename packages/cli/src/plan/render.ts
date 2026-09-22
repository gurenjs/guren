/**
 * The rendered plan (RFC 0030 §3): one self-contained HTML file that opens from
 * disk and makes no request of any kind.
 *
 * Every string in a plan is model output, and under the `github` store some of it
 * passed through an editable issue, so all of it is hostile. The data reaches the
 * page as a JSON block whose `<`, `>`, `&`, U+2028 and U+2029 are escaped, and the
 * template writes it with `textContent` only. `packages/cli/tests/plan-render.test.ts`
 * holds both halves of that to the output.
 */

import { readPlanTemplate } from './assets'
import { planDiagram } from './diagram'
import { layoutPlanFlows } from './flow'
import { planHash } from './identity'
import { impactBreakingChanges, type PlanImpactEntry } from './impact'
import { loadPlanDictionaries, matchPlanLocale, type PlanLocale } from './locales'
import { listPlanElements, type Plan, type PlanDraft } from './schema'

/**
 * A `guren check` result that names the plan element it concerns. `elementId` is
 * optional: a finding about the plan as a whole still belongs in the banner.
 */
// The one definition lives with the checks; re-exported so a caller of the renderer
// need not import the validator to name its input.
export type { PlanCheckResult } from './validate'
import type { PlanCheckResult } from './validate'

export interface RenderPlanInput {
  plan: PlanDraft | Plan
  checks?: readonly PlanCheckResult[]
  /**
   * The plan file's name, for the `plan:render` and `plan:approve` commands the page prints.
   * A name is dropped unless it is {@link PLAN_FILE_PATTERN}: the page shows those lines for
   * someone to paste into a shell, so a name carrying `;` or a quote would be pasted with it.
   */
  planFile?: string
  /** Derived task status (RFC 0030 §6). Reserved: an absent value renders nothing. */
  status?: unknown
  /** The locale the page's own words open in. Absent, the plan's `locale` decides, then `en`. */
  uiLocale?: PlanLocale
  /** Impact (RFC 0030 §2), from `planImpact()`. Absent, the page draws no Impact at all rather than an empty one. */
  impact?: readonly PlanImpactEntry[]
}

// Declared beside the page that reads them, so the two sides share one definition.
export type { PlanBreakingChange, PlanElementEntry, PlanLink, PlanPageI18n, PlanPagePayload } from './page/payload'
import type { PlanBreakingChange, PlanElementEntry, PlanLink, PlanPagePayload } from './page/payload'

const DATA_PLACEHOLDER = '__GUREN_PLAN_DATA__'

/** A bare file name with no shell metacharacter, no quote, no space and no path segment. */
export const PLAN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The template a plan is rendered into, script included. Exported for the tests that hold the document to its rules. */
export function planTemplateSource(): string {
  return readPlanTemplate().source
}

/**
 * JSON for a `<script type="application/json">` block. Outside a string literal JSON
 * writes none of these characters, so escaping them everywhere cannot change what
 * `JSON.parse` reads back: the output spells no `</script`, `<!--` or `]]>`, and no
 * U+2028 / U+2029 terminates a line in a consumer that re-evaluates the text.
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

/** Whether a document is a full `Plan` rather than a draft. The CLI picks its schema by it. */
export function hasBaseline(document: unknown): document is Plan {
  return typeof document === 'object' && document !== null && 'baseline' in document
}

function hashOf(plan: PlanDraft | Plan): string | null {
  return hasBaseline(plan) ? planHash(plan) : null
}

/**
 * Which entity each element belongs to, for the page's filter. The plan already says
 * so in `tasks[].covers`; models name their own entity, and an element no task covers
 * has none rather than a guessed one.
 */
function entityIndex(plan: PlanDraft): Map<string, string> {
  const entities = new Map<string, string>()
  for (const task of plan.tasks) {
    for (const covered of task.covers) {
      if (!entities.has(covered)) entities.set(covered, task.entity)
    }
  }
  for (const model of plan.models) {
    if (!entities.has(model.id)) entities.set(model.id, model.name)
    for (const column of model.columns) {
      if (!entities.has(column.id)) entities.set(column.id, entities.get(model.id) as string)
    }
  }
  for (const controller of plan.controllers) {
    const entity = entities.get(controller.id)
    if (entity === undefined) continue
    for (const action of controller.actions) {
      if (!entities.has(action.id)) entities.set(action.id, entity)
    }
  }
  for (const task of plan.tasks) {
    entities.set(task.id, task.entity)
    for (const acceptance of task.acceptance) entities.set(acceptance.id, task.entity)
  }
  return entities
}

/**
 * The changes that are breaking whatever Impact found (RFC 0030 §2): a dropped or
 * altered column, a renamed table, a renamed or dropped route, and any change to a
 * route already published as an agent tool.
 */
export function planBreakingChanges(plan: PlanDraft): PlanBreakingChange[] {
  const breaking: PlanBreakingChange[] = []
  const add = (
    element: Pick<PlanBreakingChange, 'elementId' | 'section' | 'title'>,
    reasonKey: string,
    reasonValues: Record<string, string> = {},
  ): void => {
    breaking.push({ ...element, reasonKey, reasonValues })
  }

  for (const model of plan.models) {
    const element = { elementId: model.id, section: 'models', title: model.name } as const
    if (model.change.kind === 'drop') {
      add(element, 'breaking.tableDropped', { table: model.table })
    } else if (model.change.kind === 'rename' || model.tableRenamedFrom !== undefined) {
      add(element, 'breaking.renamedFrom', {
        from: model.tableRenamedFrom ?? (model.change.kind === 'rename' ? model.change.from : ''),
      })
    }

    for (const column of model.columns) {
      const columnElement = { elementId: column.id, section: 'columns', title: `${model.table}.${column.name}` } as const
      if (column.change.kind === 'drop') add(columnElement, 'breaking.columnDropped')
      else if (column.change.kind === 'alter') add(columnElement, 'breaking.columnAltered')
      else if (column.change.kind === 'rename') add(columnElement, 'breaking.renamedFrom', { from: column.change.from })
    }
  }

  for (const route of plan.routes) {
    const element = { elementId: route.id, section: 'routes', title: route.name } as const
    if (route.change.kind === 'drop') add(element, 'breaking.routeDropped')
    else if (route.change.kind === 'rename') add(element, 'breaking.renamedFrom', { from: route.change.from })
    else if (route.agent !== undefined && route.change.kind === 'alter') {
      add(element, 'breaking.agentToolChanges', { tool: route.agent.toolName })
    }
  }

  return breaking
}

/**
 * Every reference one element makes to another, in document order. The page shows both
 * directions of each link (route to action to validator to view to model, and back), so
 * only the forward direction is listed here. Containment is not a reference: a column
 * inside its model, or an action inside its controller, is drawn by the nesting.
 */
export function planLinks(plan: PlanDraft): PlanLink[] {
  const links: PlanLink[] = []
  const declared = new Set(listPlanElements(plan).map((element) => element.id))
  // A reference to an id the plan never declares is a §2 check failure, not a link:
  // an anchor to it would land nowhere.
  const link = (from: string, to: string | undefined, label: string): void => {
    if (to === undefined || !declared.has(to) || to === from) return
    links.push({ from, to, label })
  }

  for (const model of plan.models) {
    for (const column of model.columns) {
      link(column.id, column.references?.model, 'references')
    }
    for (const relationship of model.relationships) link(model.id, relationship.target, relationship.type)
  }

  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      link(action.id, action.params, 'params')
      link(action.id, action.query, 'query')
      link(action.id, action.body, 'body')
      link(action.id, action.authorization.policy?.id, 'policy')
      if (action.response.kind === 'inertia') link(action.id, action.response.view, 'renders')
      if (action.response.kind === 'resource') link(action.id, action.response.resource, 'returns')
    }
  }

  for (const route of plan.routes) {
    link(route.id, route.action, 'action')
    for (const binding of route.bind) link(route.id, binding.model, `bind ${binding.param}`)
  }

  for (const view of plan.views) {
    for (const prop of view.props) link(view.id, prop.resource, `prop ${prop.name}`)
    if (view.form) {
      link(view.id, view.form.validator, 'form validator')
      link(view.id, view.form.submitsTo, 'submits to')
    }
    for (const action of view.actions) link(view.id, action.route, action.label)
  }

  for (const flow of plan.flows) {
    for (const node of flow.nodes) link(flow.id, node.element, node.label)
  }

  for (const resource of plan.resources) link(resource.id, resource.model, 'model')
  for (const policy of plan.policies) link(policy.id, policy.model, 'model')

  for (const task of plan.tasks) {
    for (const covered of task.covers) link(task.id, covered, 'covers')
    for (const acceptance of task.acceptance) {
      link(acceptance.id, acceptance.route, 'route')
      link(acceptance.id, acceptance.expect.inertia, 'expects page')
    }
  }

  return links
}

export function buildPlanPayload(input: RenderPlanInput): PlanPagePayload {
  const plan = input.plan
  const entities = entityIndex(plan)
  const elements: PlanElementEntry[] = listPlanElements(plan).map((element) => ({
    id: element.id,
    entity: entities.get(element.id) ?? null,
  }))

  const breaking = planBreakingChanges(plan)
  return {
    plan,
    planHash: hashOf(plan),
    checks: [...(input.checks ?? [])],
    breaking: input.impact ? [...breaking, ...impactBreakingChanges(plan, input.impact, breaking)] : breaking,
    impact: input.impact ? [...input.impact] : null,
    diagram: planDiagram(plan),
    flows: layoutPlanFlows(plan),
    planFile: input.planFile !== undefined && PLAN_FILE_PATTERN.test(input.planFile) ? input.planFile : null,
    elements,
    links: planLinks(plan),
    // From the elements rather than from `tasks[].entity`: a model names its own
    // entity, so a plan with no tasks would otherwise assign entities the filter
    // cannot offer.
    entities: [...new Set(elements.map((element) => element.entity))].filter((entity) => entity !== null).sort(),
    status: input.status ?? null,
    i18n: { initial: input.uiLocale ?? matchPlanLocale(plan.locale) ?? 'en', dictionaries: loadPlanDictionaries() },
  }
}

/** The plan as one self-contained HTML document. Pure: nothing but the template is read. */
export function renderPlanHtml(input: RenderPlanInput): string {
  const payload = escapeJsonForScript(JSON.stringify(buildPlanPayload(input)))
  // A replacement *function*, never a string: `$&`, "$`" and `$'` anywhere in the plan
  // would otherwise be expanded by `replace` and corrupt the document.
  return planTemplateSource().replace(DATA_PLACEHOLDER, () => payload)
}
