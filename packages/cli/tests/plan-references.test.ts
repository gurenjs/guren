import { describe, expect, test } from 'bun:test'

import {
  listPlanReferences,
  PLAN_REFERENCES,
  PLAN_REFERENCE_OWNER_PATHS,
} from '../src/plan/references'
import { PlanDraftSchema, planDraftJsonSchema, type PlanDraft } from '../src/plan/schema'
import { loadCommentsPlan } from './plan-fixture'

type Json = Record<string, unknown>

function plan(): PlanDraft {
  return PlanDraftSchema.parse(loadCommentsPlan())
}

describe('PLAN_REFERENCES', () => {
  test('should name every id-typed field of the plan schema that is not a declaration', () => {
    const schema = planDraftJsonSchema() as Json
    const idPattern = (((schema.properties as Json).questions as Json).items as { properties: { id: { pattern: string } } })
      .properties.id.pattern
    const found = new Set<string>()
    const visit = (node: Json, path: string): void => {
      if (node.pattern === idPattern) found.add(path)
      for (const [key, value] of Object.entries((node.properties ?? {}) as Record<string, Json>)) {
        visit(value, path ? `${path}.${key}` : key)
      }
      if (node.items) visit(node.items as Json, `${path}[]`)
      for (const option of [...((node.oneOf ?? []) as Json[]), ...((node.anyOf ?? []) as Json[])]) visit(option, path)
    }
    visit(schema, '')

    const declarations = [
      'questions[].id',
      'models[].id',
      'models[].columns[].id',
      'validators[].id',
      'controllers[].id',
      'controllers[].actions[].id',
      'routes[].id',
      'views[].id',
      'resources[].id',
      'policies[].id',
      'sideEffects[].id',
      'flows[].id',
      'commands[].id',
      'tasks[].id',
      'tasks[].acceptance[].id',
    ]
    const flowLocal = ['flows[].nodes[].id', 'flows[].edges[].from', 'flows[].edges[].to']
    const references = PLAN_REFERENCES.map((entry) => `${PLAN_REFERENCE_OWNER_PATHS[entry.owner]}.${entry.path}`)

    expect([...found].sort()).toEqual([...declarations, ...flowLocal, ...references].sort())
  })

  test('should give every entry a field of its own', () => {
    const fields = PLAN_REFERENCES.map((entry) => entry.field)

    expect([...new Set(fields)]).toEqual(fields)
  })
})

describe('listPlanReferences', () => {
  test('should read the fixture in document order, each reference labelled as a finding names it', () => {
    const references = listPlanReferences(plan())

    expect(references.map((reference) => [reference.from.id, reference.field, reference.to, reference.label])).toEqual([
      ['Q-delete', 'question.affects', 'model.comment', 'The question affects'],
      ['Q-delete', 'question.affects', 'action.comments.destroy', 'The question affects'],
      ['model.post', 'model.relationship', 'model.comment', 'Relationship "comments"'],
      ['model.comment', 'model.relationship', 'model.post', 'Relationship "post"'],
      ['column.comment.postId', 'column.references', 'model.post', 'The foreign key on "postId"'],
      ['action.comments.store', 'action.body', 'validator.comment', 'The body validator'],
      ['action.comments.destroy', 'action.policy', 'policy.comment', 'The policy'],
      ['route.comments.store', 'route.action', 'action.comments.store', 'The route action'],
      ['route.comments.store', 'route.bind', 'model.post', 'The binding for ":postId"'],
      ['route.comments.destroy', 'route.action', 'action.comments.destroy', 'The route action'],
      ['route.comments.destroy', 'route.bind', 'model.comment', 'The binding for ":id"'],
      ['view.posts.show', 'view.propResource', 'resource.comment', 'The resource of prop "comments"'],
      ['view.posts.show', 'view.actionRoute', 'route.comments.destroy', 'The route of action "Delete"'],
      ['view.posts.show', 'view.formValidator', 'validator.comment', 'The form validator'],
      ['view.posts.show', 'view.formSubmitsTo', 'route.comments.store', 'The form target'],
      ['resource.comment', 'resource.model', 'model.comment', 'The resource model'],
      ['policy.comment', 'policy.model', 'model.comment', 'The policy model'],
      ['task.comments', 'task.covers', 'model.post', 'The task covers'],
      ['task.comments', 'task.covers', 'model.comment', 'The task covers'],
      ['task.comments', 'task.covers', 'validator.comment', 'The task covers'],
      ['task.comments', 'task.covers', 'controller.comments', 'The task covers'],
      ['task.comments', 'task.covers', 'route.comments.store', 'The task covers'],
      ['task.comments', 'task.covers', 'route.comments.destroy', 'The task covers'],
      ['task.comments', 'task.covers', 'view.posts.show', 'The task covers'],
      ['task.comments', 'task.covers', 'resource.comment', 'The task covers'],
      ['task.comments', 'task.covers', 'policy.comment', 'The task covers'],
      ['AC-comments-1', 'acceptance.route', 'route.comments.store', 'The behaviour route'],
      ['AC-comments-2', 'acceptance.route', 'route.comments.store', 'The behaviour route'],
      ['AC-comments-3', 'acceptance.route', 'route.comments.store', 'The behaviour route'],
      ['AC-comments-4', 'acceptance.route', 'route.comments.destroy', 'The behaviour route'],
    ])
  })

  test('should read a reference the fixture does not make', () => {
    const draft = plan()
    draft.controllers[0].actions[0].params = 'validator.comment'
    draft.controllers[0].actions[0].query = 'validator.comment'
    draft.controllers[0].actions[1].response = { kind: 'inertia', view: 'view.posts.show' }
    draft.tasks[0].acceptance[0].expect.inertia = 'view.posts.show'
    draft.flows = [
      {
        id: 'flow.comment',
        change: { kind: 'add' },
        title: 'Leaving a comment',
        nodes: [{ id: 'form', label: 'The form', kind: 'page', element: 'view.posts.show' }],
        edges: [],
      },
    ]

    const fields = new Map(listPlanReferences(draft).map((reference) => [reference.field, reference]))

    expect(fields.get('action.params')?.to).toBe('validator.comment')
    expect(fields.get('action.query')?.label).toBe('The query validator')
    expect(fields.get('action.view')?.expected).toBe('views')
    expect(fields.get('acceptance.inertia')?.from).toEqual({ id: 'AC-comments-1', section: 'acceptance' })
    expect(fields.get('flow.node')?.label).toBe('Flow step "The form"')
  })

  test('should report a reference to an id no element declares, since that is what a check refuses', () => {
    const draft = plan()
    draft.resources[0].model = 'model.ghost'

    const reference = listPlanReferences(draft).find((candidate) => candidate.field === 'resource.model')

    expect(reference?.to).toBe('model.ghost')
  })

  test('should skip a reference the plan leaves out rather than report it as empty', () => {
    const draft = plan()
    draft.views[0].form = undefined
    draft.models[1].columns[2].references = undefined

    const fields = listPlanReferences(draft).map((reference) => reference.field)

    expect(fields).not.toContain('view.formValidator')
    expect(fields).not.toContain('column.references')
  })
})
