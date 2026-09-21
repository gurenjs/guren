/**
 * Every place a plan element names another by id (RFC 0030 §1), as one table.
 * The §2 reference checks, the §5 task derivation and a revision's
 * dangling-name rule all read it: a path one of the three knows and the others
 * do not is how a revision passes a plan the checks then reject.
 * `plan-references.test.ts` holds the table to the schema's id-typed fields.
 * A flow's step ids and edge ends are that flow's own namespace, not references.
 */

import {
  listPlanElementEntries,
  type PlanDraft,
  type PlanElementRef,
  type PlanElementSection,
} from './schema'

type Holder = Record<string, unknown>

/** The sections whose elements name other elements. */
export type PlanReferenceOwner = Extract<
  PlanElementSection,
  'questions' | 'models' | 'columns' | 'actions' | 'routes' | 'views' | 'resources' | 'policies' | 'flows' | 'tasks' | 'acceptance'
>

/** Where each owner sits in the document, as the drift test spells a path. */
export const PLAN_REFERENCE_OWNER_PATHS: Record<PlanReferenceOwner, string> = {
  questions: 'questions[]',
  models: 'models[]',
  columns: 'models[].columns[]',
  actions: 'controllers[].actions[]',
  routes: 'routes[]',
  views: 'views[]',
  resources: 'resources[]',
  policies: 'policies[]',
  flows: 'flows[]',
  tasks: 'tasks[]',
  acceptance: 'tasks[].acceptance[]',
}

export type PlanReferenceField =
  | 'question.affects'
  | 'model.relationship'
  | 'column.references'
  | 'action.params'
  | 'action.query'
  | 'action.body'
  | 'action.policy'
  | 'action.view'
  | 'action.resource'
  | 'flow.node'
  | 'route.action'
  | 'route.bind'
  | 'view.propResource'
  | 'view.actionRoute'
  | 'view.formValidator'
  | 'view.formSubmitsTo'
  | 'resource.model'
  | 'policy.model'
  | 'task.covers'
  | 'acceptance.route'
  | 'acceptance.inertia'

interface PlanReferenceDefinition {
  field: PlanReferenceField
  owner: PlanReferenceOwner
  /** From the owner to the id, as {@link reach} walks it. */
  path: string
  /** The section the target has to be in; `null` where the reference may name any element. */
  expected: PlanElementSection | null
  /**
   * How the reference reads in a message. `site` is the object holding the id, which
   * for `bind[].model` is the binding rather than the route.
   */
  label: (site: Holder, owner: Holder) => string
}

/** One reference an element makes. */
export interface PlanReference {
  from: PlanElementRef
  /** The id named, which need not be declared. */
  to: string
  expected: PlanElementSection | null
  label: string
  field: PlanReferenceField
}

const definition = (
  field: PlanReferenceField,
  owner: PlanReferenceOwner,
  path: string,
  expected: PlanElementSection | null,
  label: PlanReferenceDefinition['label'] | string,
): PlanReferenceDefinition => ({
  field,
  owner,
  path,
  expected,
  label: typeof label === 'string' ? () => label : label,
})

const quoted = (value: unknown): string => `"${String(value)}"`

/**
 * Every reference path, with the section its target belongs to. Order is the order a
 * reader sees an owner's references in, which is what puts the §2 findings of one
 * element in the order the page lists them.
 */
export const PLAN_REFERENCES: ReadonlyArray<PlanReferenceDefinition> = [
  definition('question.affects', 'questions', 'affects[]', null, 'The question affects'),
  definition('model.relationship', 'models', 'relationships[].target', 'models', (site) => `Relationship ${quoted(site.name)}`),
  definition('column.references', 'columns', 'references.model', 'models', (_site, owner) => `The foreign key on ${quoted(owner.name)}`),
  definition('action.params', 'actions', 'params', 'validators', 'The params validator'),
  definition('action.query', 'actions', 'query', 'validators', 'The query validator'),
  definition('action.body', 'actions', 'body', 'validators', 'The body validator'),
  definition('action.policy', 'actions', 'authorization.policy.id', 'policies', 'The policy'),
  definition('action.view', 'actions', 'response.view', 'views', 'The response page'),
  definition('action.resource', 'actions', 'response.resource', 'resources', 'The response resource'),
  definition('flow.node', 'flows', 'nodes[].element', null, (site) => `Flow step ${quoted(site.label)}`),
  definition('route.action', 'routes', 'action', 'actions', 'The route action'),
  definition('route.bind', 'routes', 'bind[].model', 'models', (site) => `The binding for ":${String(site.param)}"`),
  definition('view.propResource', 'views', 'props[].resource', 'resources', (site) => `The resource of prop ${quoted(site.name)}`),
  definition('view.actionRoute', 'views', 'actions[].route', 'routes', (site) => `The route of action ${quoted(site.label)}`),
  definition('view.formValidator', 'views', 'form.validator', 'validators', 'The form validator'),
  definition('view.formSubmitsTo', 'views', 'form.submitsTo', 'routes', 'The form target'),
  definition('resource.model', 'resources', 'model', 'models', 'The resource model'),
  definition('policy.model', 'policies', 'model', 'models', 'The policy model'),
  definition('task.covers', 'tasks', 'covers[]', null, 'The task covers'),
  definition('acceptance.route', 'acceptance', 'route', 'routes', 'The behaviour route'),
  definition('acceptance.inertia', 'acceptance', 'expect.inertia', 'views', 'The expected page'),
]

const BY_OWNER = new Map<PlanElementSection, PlanReferenceDefinition[]>()
for (const entry of PLAN_REFERENCES) {
  const bucket = BY_OWNER.get(entry.owner)
  if (bucket) bucket.push(entry)
  else BY_OWNER.set(entry.owner, [entry])
}

/** Every id one element names another by, in document order. */
export function listPlanReferences(plan: PlanDraft): PlanReference[] {
  const references: PlanReference[] = []
  for (const { id, section, element } of listPlanElementEntries(plan)) {
    for (const entry of BY_OWNER.get(section) ?? []) {
      for (const { value, site } of reach(element, entry.path)) {
        if (typeof value !== 'string') continue
        references.push({
          from: { id, section },
          to: value,
          expected: entry.expected,
          label: entry.label(site, element),
          field: entry.field,
        })
      }
    }
  }
  return references
}

/** Every value a path reaches, with the object the last segment was read from. */
function reach(root: Holder, path: string): Array<{ value: unknown; site: Holder }> {
  let found = [{ value: root as unknown, site: root }]
  for (const segment of path.split('.')) {
    const many = segment.endsWith('[]')
    const key = many ? segment.slice(0, -2) : segment
    found = found.flatMap(({ value }) => {
      if (value === null || typeof value !== 'object') return []
      const site = value as Holder
      const member = site[key]
      if (member === undefined) return []
      return many ? (member as unknown[]).map((item) => ({ value: item, site })) : [{ value: member, site }]
    })
  }
  return found
}
