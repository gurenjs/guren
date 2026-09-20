/** One renderer per plan section. Each reads the plan's own fields, typed by the schema. */

import type { PlanAcceptance, PlanColumn, PlanFlow, PlanModel, PlanRoute } from '../schema'
import { card, entityOf, group, kv } from './card'
import { el, idMap, link, list, span } from './dom'
import { drawFlow } from './flow'
import { ariaLabel, t, tel, words, type PhraseValues } from './locale'
import type { PlanPagePayload } from './payload'

type SectionKey =
  | 'models'
  | 'views'
  | 'controllers'
  | 'routes'
  | 'validators'
  | 'resources'
  | 'policies'
  | 'sideEffects'
  | 'flows'
  | 'commands'
  | 'tasks'

export interface Section {
  key: SectionKey
  label: string
  render(host: HTMLElement, data: PlanPagePayload): void
}

// The renderer sits beside its key rather than in a second map keyed the same way: a
// section added to one list only would otherwise render an empty panel or throw.
export const SECTIONS: readonly Section[] = [
  { key: 'models', label: 'sections.models', render: renderModels },
  { key: 'views', label: 'sections.views', render: renderViews },
  { key: 'controllers', label: 'sections.controllers', render: renderControllers },
  { key: 'routes', label: 'sections.routes', render: renderRoutes },
  { key: 'validators', label: 'sections.validators', render: renderValidators },
  { key: 'resources', label: 'sections.resources', render: renderResources },
  { key: 'policies', label: 'sections.policies', render: renderPolicies },
  { key: 'sideEffects', label: 'sections.sideEffects', render: renderSideEffects },
  { key: 'flows', label: 'sections.flows', render: renderFlows },
  { key: 'commands', label: 'sections.commands', render: renderCommands },
  { key: 'tasks', label: 'sections.tasks', render: renderTasks },
]

/** Where the models section left room for the diagram, which is drawn once the panel is in the document. */
export let diagramHost: HTMLElement | null = null

/**
 * A column as one mono line, the way the diagram already writes one: the type,
 * then only the facts that are true.
 */
function columnFacts(column: PlanColumn): HTMLSpanElement {
  const facts = [column.type + (column.precision ? '(' + column.precision + ',' + (column.scale || 0) + ')' : '')]
  if (column.primaryKey) facts.push('pk')
  if (column.nullable) facts.push('null')
  if (column.unique) facts.push('uniq')
  if (column.index) facts.push('idx')
  if (column.withTimezone) facts.push('tz')
  if (column.default !== undefined) facts.push('default ' + column.default)
  if (column.columnName !== undefined) facts.push('as ' + column.columnName)

  const parts: Array<string | Node> = [facts.join('  ')]
  if (column.references) {
    parts.push('  references ')
    parts.push(link(column.references.model))
    parts.push('.' + column.references.column + (column.references.onDelete ? ' on delete ' + column.references.onDelete : ''))
  }
  const line = span(parts)
  line.className = 'facts'
  return line
}

/** `none` says why nothing moves; the other kinds say what does. */
function migrationDetail(migration: NonNullable<PlanModel['dataMigration']>): string {
  return migration.kind === 'none' ? migration.reason : migration.description
}

function renderModels(host: HTMLElement, { plan }: PlanPagePayload): void {
  const diagramPanel = el('div', 'panel')
  diagramPanel.appendChild(tel('h2', null, 'diagram.heading'))
  diagramHost = el('div')
  diagramPanel.appendChild(diagramHost)
  host.appendChild(diagramPanel)

  for (const model of plan.models) {
    const body = el('div')
    body.appendChild(
      kv([
        [
          'models.table',
          model.tableRenamedFrom
            ? tel('span', null, 'models.tableRenamed', { table: model.table, from: model.tableRenamedFrom })
            : model.table,
        ],
        ['label.module', model.module],
        ['models.fillable', model.fillable.join(', ')],
        [
          'models.dataMigration',
          model.dataMigration ? model.dataMigration.kind + ': ' + migrationDetail(model.dataMigration) : null,
        ],
      ]),
    )
    if (model.relationships.length) {
      group(body, 'models.relationships', model.relationships, (relationship) =>
        tel('span', null, 'models.relationship', {
          name: relationship.name,
          type: relationship.type,
          target: link(relationship.target),
        }),
      )
    }
    if (model.indexes.length) {
      group(body, 'models.indexes', model.indexes, (index) => {
        const columns = index.columns.join(', ')
        return index.unique ? tel('span', null, 'models.uniqueIndex', { columns: columns }) : columns
      })
    }
    const node = card({ id: model.id, title: model.name, change: model.change, body: body })

    if (model.columns.length) {
      const columnsHost = el('div')
      columnsHost.appendChild(tel('h4', null, 'models.columns'))
      for (const column of model.columns) {
        const columnBody = el('div')
        columnBody.appendChild(columnFacts(column))
        if (column.dataMigration) {
          columnBody.appendChild(
            tel('p', 'note', 'models.columnDataMigration', {
              kind: column.dataMigration.kind,
              detail: migrationDetail(column.dataMigration),
            }),
          )
        }
        columnsHost.appendChild(
          card({ id: column.id, title: column.name, change: column.change, body: columnBody, sub: true, parent: node }),
        )
      }
      node.appendChild(columnsHost)
    }
    host.appendChild(node)
  }
}

function renderViews(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const view of plan.views) {
    const body = el('div')
    body.appendChild(kv([['views.page', view.page], ['label.module', view.module], ['views.purpose', view.purpose]]))
    if (view.props.length) {
      group(body, 'views.props', view.props, (prop) =>
        prop.resource
          ? tel('span', null, 'views.propFrom', { name: prop.name, type: prop.type, resource: link(prop.resource) })
          : tel('span', null, 'views.prop', { name: prop.name, type: prop.type }),
      )
    }
    if (view.form) {
      body.appendChild(tel('h4', null, 'views.form'))
      const form = el('div')
      form.appendChild(
        tel('span', 'note', 'views.formMeta', { validator: link(view.form.validator), route: link(view.form.submitsTo) }),
      )
      form.appendChild(
        list(view.form.fields, (field) =>
          tel('span', null, 'views.formField', { label: field.label, field: field.field, input: field.input }),
        ),
      )
      body.appendChild(form)
    }
    if (view.actions.length) {
      group(body, 'views.actions', view.actions, (action) =>
        tel('span', null, 'views.action', { label: action.label, route: link(action.route) }),
      )
    }
    body.appendChild(
      kv([['views.empty', view.states.empty], ['views.error', view.states.error], ['views.loading', view.states.loading]]),
    )
    host.appendChild(card({ id: view.id, title: view.page, change: view.change, body: body }))
  }
}

function renderControllers(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const controller of plan.controllers) {
    const node = card({
      id: controller.id,
      title: controller.className,
      change: controller.change,
      body: kv([['label.module', controller.module]]),
    })
    for (const action of controller.actions) {
      const body = el('div')
      const response = action.response
      const responseCell =
        response.kind === 'inertia'
          ? words(link(response.view, ''), 'controllers.renders', { view: response.view })
          : response.kind === 'resource'
            ? words(link(response.resource, ''), 'controllers.returns', { resource: response.resource })
            : response.kind === 'redirect'
              ? tel('span', null, 'controllers.redirect', { target: response.to })
              : response.kind === 'json'
                ? tel('span', null, 'controllers.json', { description: response.description })
                : tel('span', null, 'controllers.emptyResponse')
      body.appendChild(
        kv([
          ['controllers.params', action.params ? link(action.params) : null],
          ['controllers.query', action.query ? link(action.query) : null],
          ['controllers.body', action.body ? link(action.body) : null],
          ['controllers.middleware', action.authorization.middleware.join(', ')],
          [
            'controllers.policy',
            action.authorization.policy
              ? tel('span', null, 'controllers.policyAbility', {
                  policy: link(action.authorization.policy.id),
                  ability: action.authorization.policy.ability,
                })
              : null,
          ],
          ['controllers.response', responseCell],
        ]),
      )
      if (action.rules.length) group(body, 'controllers.rules', action.rules)
      node.appendChild(card({ id: action.id, title: action.name, change: action.change, body: body, sub: true, parent: node }))
    }
    host.appendChild(node)
  }
}

function bindingsLine(bindings: PlanRoute['bind']): HTMLSpanElement {
  const line = el('span')
  bindings.forEach((binding, index) => {
    if (index) line.appendChild(document.createTextNode(', '))
    line.appendChild(
      tel('span', null, binding.key ? 'routes.bindingBy' : 'routes.binding', {
        param: binding.param,
        model: link(binding.model),
        key: binding.key,
      }),
    )
  })
  return line
}

function renderRoutes(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const route of plan.routes) {
    const body = el('div')
    body.appendChild(
      kv([
        ['routes.path', route.method + ' ' + route.path],
        ['routes.action', link(route.action)],
        ['routes.middleware', route.middleware.join(', ')],
        ['routes.bind', route.bind.length ? bindingsLine(route.bind) : null],
        [
          'routes.agentTool',
          route.agent
            ? route.agent.readOnly
              ? tel('span', null, 'routes.agentReadOnly', { tool: route.agent.toolName })
              : route.agent.toolName
            : null,
        ],
      ]),
    )
    host.appendChild(card({ id: route.id, title: route.name, change: route.change, body: body }))
  }
}

function renderValidators(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const validator of plan.validators) {
    const body = el('div')
    body.appendChild(kv([['label.module', validator.module]]))
    group(body, 'label.fields', validator.fields, (field) => {
      const described = (): PhraseValues => ({
        name: field.name,
        type: field.type,
        requirement: t(field.required ? 'validators.required' : 'validators.optional'),
      })
      if (!field.rules.length) return tel('span', null, 'validators.field', described)
      return tel('span', null, 'validators.fieldRules', () => ({
        field: t('validators.field', described),
        rules: field.rules.join(', '),
      }))
    })
    host.appendChild(card({ id: validator.id, title: validator.name, change: validator.change, body: body }))
  }
}

function renderResources(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const resource of plan.resources) {
    const body = el('div')
    body.appendChild(kv([['label.module', resource.module], ['label.model', link(resource.model)]]))
    group(body, 'label.fields', resource.fields, (field) => field.name + ': ' + field.type)
    host.appendChild(card({ id: resource.id, title: resource.name, change: resource.change, body: body }))
  }
}

function renderPolicies(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const policy of plan.policies) {
    const body = el('div')
    body.appendChild(kv([['label.module', policy.module], ['label.model', link(policy.model)]]))
    group(body, 'policies.abilities', policy.abilities, (ability) => ability.name + ': ' + ability.rule)
    host.appendChild(card({ id: policy.id, title: policy.name, change: policy.change, body: body }))
  }
}

function renderSideEffects(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const effect of plan.sideEffects) {
    const body = kv([
      ['sideEffects.kind', effect.kind],
      ['label.module', effect.module],
      ['sideEffects.trigger', effect.trigger],
      ['sideEffects.description', effect.description],
    ])
    host.appendChild(card({ id: effect.id, title: effect.name, change: effect.change, body: body }))
  }
}

function renderFlows(host: HTMLElement, data: PlanPagePayload): void {
  const declared = idMap<PlanFlow>()
  for (const flow of data.plan.flows) declared[flow.id] = flow
  for (const flow of data.flows) {
    const body = el('div')
    if (flow.description) body.appendChild(el('p', null, flow.description))
    const scroll = el('div', 'flow-scroll')
    const drawing = drawFlow(flow, entityOf, '')
    ariaLabel(drawing, 'flows.label', { title: flow.title })
    scroll.appendChild(drawing)
    body.appendChild(scroll)
    // The layout keeps a change's kind; the badge also reads what a rename was
    // from and why a drop, which only the plan's own flow carries.
    const change = declared[flow.id]?.change ?? { kind: flow.change }
    host.appendChild(card({ id: flow.id, title: flow.title, change: change, body: body }))
  }
}

function renderCommands(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const command of plan.commands) {
    const body = el('div')
    body.appendChild(el('p', 'mono', command.command))
    body.appendChild(el('p', 'note', command.reason))
    host.appendChild(card({ id: command.id, title: command.command, body: body }))
  }
}

function jsonValues(values: ReadonlyArray<{ name: string; json: string }>): string {
  return values.map((value) => value.name + ' = ' + value.json).join(', ')
}

function renderAcceptance(acceptance: PlanAcceptance): HTMLDivElement {
  const body = el('div')
  const gwt = el('div', 'given-when-then')

  gwt.appendChild(tel('div', 'label', 'acceptance.given'))
  const given = el('div')
  if (acceptance.given.length) given.appendChild(list(acceptance.given))
  else given.appendChild(tel('span', 'note', 'acceptance.givenNothing'))
  gwt.appendChild(given)

  gwt.appendChild(tel('div', 'label', 'acceptance.when'))
  gwt.appendChild(
    acceptance.input && acceptance.input.length
      ? tel('span', null, 'acceptance.callsWith', {
          actor: acceptance.actor,
          route: link(acceptance.route),
          input: jsonValues(acceptance.input),
        })
      : tel('span', null, 'acceptance.calls', { actor: acceptance.actor, route: link(acceptance.route) }),
  )

  gwt.appendChild(tel('div', 'label', 'acceptance.then'))
  const then = el('div')
  const expectations: Node[] = []
  const expecting = (key: string, values: PhraseValues): void => {
    expectations.push(tel('span', null, key, values))
  }
  if (acceptance.expect.status !== undefined) expecting('acceptance.status', { status: acceptance.expect.status })
  if (acceptance.expect.redirect !== undefined) expecting('acceptance.redirect', { target: acceptance.expect.redirect })
  if (acceptance.expect.errors) expecting('acceptance.errors', { fields: acceptance.expect.errors.join(', ') })
  for (const row of acceptance.expect.database ?? []) {
    if (row.has) expecting('acceptance.has', { table: row.table, values: jsonValues(row.has) })
    if (row.missing) expecting('acceptance.hasNo', { table: row.table, values: jsonValues(row.missing) })
  }
  if (expectations.length) then.appendChild(list(expectations))
  if (acceptance.expect.inertia) {
    then.appendChild(tel('span', 'note', 'acceptance.renders', { page: link(acceptance.expect.inertia) }))
  }
  gwt.appendChild(then)
  body.appendChild(gwt)
  return body
}

function renderTasks(host: HTMLElement, { plan }: PlanPagePayload): void {
  for (const task of plan.tasks) {
    const covers = el('p', 'note referenced-by')
    covers.appendChild(tel('span', 'label', 'tasks.covers'))
    task.covers.forEach((elementId, index) => {
      if (index) covers.appendChild(document.createTextNode(', '))
      covers.appendChild(link(elementId))
    })
    const taskBody = el('div')
    taskBody.appendChild(kv([['tasks.entity', task.entity]]))
    taskBody.appendChild(covers)
    const node = card({ id: task.id, title: task.entity + ' - ' + task.summary, body: taskBody })
    for (const acceptance of task.acceptance) {
      node.appendChild(
        card({
          id: acceptance.id,
          title: acceptance.description,
          sub: true,
          parent: node,
          extraBadges: [el('span', 'badge badge-kind', acceptance.kind)],
          body: renderAcceptance(acceptance),
        }),
      )
    }
    host.appendChild(node)
  }
}
