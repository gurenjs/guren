import { describe, expect, test } from 'bun:test'

import type { CheckStatus } from '../src/check-result'
import type { PlanAppState } from '../src/plan/app-state'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { validatePlan, type PlanCheckResult } from '../src/plan/validate'
import { loadCommentsPlan } from './plan-fixture'

function plan(): PlanDraft {
  return PlanDraftSchema.parse(loadCommentsPlan())
}

/** An application the comments fixture is a clean delta against. */
function appState(overrides: Partial<PlanAppState> = {}): PlanAppState {
  return {
    models: ['Post', 'User'],
    controllers: ['PostController'],
    actions: ['PostController.index', 'PostController.show'],
    resources: ['PostResource'],
    policies: ['PostPolicy'],
    pages: ['posts/Index', 'posts/Show'],
    validators: { unreadable: 'validators are named by exported symbol' },
    routes: [
      { name: 'posts.index', method: 'GET', path: '/posts' },
      { name: 'posts.show', method: 'GET', path: '/posts/:id' },
    ],
    tables: [
      { identifier: 'posts', tableName: 'posts', columns: ['id', 'title', 'body'] },
      { identifier: 'users', tableName: 'users', columns: ['id', 'email'] },
    ],
    apiOnly: false,
    ...overrides,
  }
}

function failures(results: PlanCheckResult[]): PlanCheckResult[] {
  return results.filter((result) => result.status === 'fail')
}

function find(results: PlanCheckResult[], key: string, elementId?: string): PlanCheckResult | undefined {
  return results.find((result) => result.key === key && (elementId === undefined || result.elementId === elementId))
}

/**
 * The result a check is expected to have produced. Asserting its presence separately
 * names the check that vanished, which `expect(undefined?.status)` does not.
 */
function expectResult(
  results: PlanCheckResult[],
  key: string,
  elementId: string,
  status: CheckStatus,
): PlanCheckResult {
  const found = find(results, key, elementId)
  expect(found, `${key} on ${elementId}`).toBeDefined()
  expect(found?.status).toBe(status)
  return found as PlanCheckResult
}

/** An unreadable-section warning carries no element id, so it is selected by its text. */
function unreadableMessages(results: PlanCheckResult[]): string[] {
  return results.filter((result) => result.key === 'plan:app-unreadable').map((result) => result.message)
}

describe('validatePlan', () => {
  test('should report no failure for the fixture against a matching application', () => {
    const results = validatePlan(plan(), appState())

    expect(failures(results)).toEqual([])
  })

  test('should raise exactly the fixture\'s three warnings', () => {
    const warns = validatePlan(plan(), appState()).filter((result) => result.status === 'warn')

    // Sorted: the order is an artifact of the call sequence in validatePlan, not a contract.
    expect(warns.map((warn) => `${warn.key} ${warn.elementId ?? ''}`).sort()).toEqual([
      'plan:acceptance route.comments.destroy',
      'plan:app-unreadable ',
      'plan:route-authorization route.comments.store',
    ])
  })

  test('should fail a route whose action id names no action', () => {
    const draft = plan()
    draft.routes[0].action = 'action.comments.missing'

    const result = expectResult(validatePlan(draft, appState()), 'plan:reference', 'route.comments.store', 'fail')
    expect(result?.message).toContain('action.comments.missing')
  })

  test('should fail an action whose response page is not a view', () => {
    const draft = plan()
    draft.controllers[0].actions[0].response = { kind: 'inertia', view: 'view.posts.missing' }

    const result = expectResult(validatePlan(draft, appState()), 'plan:reference', 'action.comments.store', 'fail')
    expect(result?.message).toContain('view.posts.missing')
  })

  test('should fail a form field that names no field of its validator', () => {
    const draft = plan()
    draft.views[0].form!.fields[0].field = 'title'

    const result = expectResult(validatePlan(draft, appState()), 'plan:reference', 'view.posts.show', 'fail')
    expect(result?.message).toContain('The form field "title"')
  })

  test('should fail a foreign key to a model the plan does not declare', () => {
    const draft = plan()
    draft.models[1].columns[2].references!.model = 'model.author'

    expectResult(validatePlan(draft, appState()), 'plan:reference', 'column.comment.postId', 'fail')
  })

  test('should fail a question affecting an id no element declares', () => {
    const draft = plan()
    draft.questions[0].affects.push('model.ghost')

    const result = expectResult(validatePlan(draft, appState()), 'plan:reference', 'Q-delete', 'fail')
    expect(result?.message).toContain('model.ghost')
  })

  test('should fail a task covering an id no element declares', () => {
    const draft = plan()
    draft.tasks[0].covers.push('view.ghost')

    const result = expectResult(validatePlan(draft, appState()), 'plan:reference', 'task.comments', 'fail')
    expect(result?.message).toContain('view.ghost')
  })

  test('should fail an acceptance behaviour naming an unknown route', () => {
    const draft = plan()
    draft.tasks[0].acceptance[0].route = 'route.comments.patch'

    expectResult(validatePlan(draft, appState()), 'plan:reference', 'AC-comments-1', 'fail')
  })

  test('should fail a duplicated id', () => {
    const draft = plan()
    draft.resources[0].id = 'policy.comment'

    expectResult(validatePlan(draft, appState()), 'plan:duplicate-id', 'policy.comment', 'fail')
  })

  test('should fail an added model whose class the application already has', () => {
    const draft = plan()
    const results = validatePlan(draft, appState({ models: ['Post', 'User', 'Comment'] }))

    const result = expectResult(results, 'plan:app-collision', 'model.comment', 'fail')
    expect(result?.message).toContain('The model class "Comment"')
  })

  test('should fail an added route whose name the application already has', () => {
    const results = validatePlan(
      plan(),
      appState({ routes: [{ name: 'comments.store', method: 'POST', path: '/comments' }] }),
    )

    const result = expectResult(results, 'plan:app-collision', 'route.comments.store', 'fail')
    expect(result?.message).toContain('The route name "comments.store"')
  })

  test('should fail an added route whose method and path the application already registers', () => {
    const results = validatePlan(
      plan(),
      appState({ routes: [{ name: 'posts.comment', method: 'POST', path: '/posts/:postId/comments' }] }),
    )

    const result = expectResult(results, 'plan:app-collision', 'route.comments.store', 'fail')
    expect(result?.message).toContain('POST /posts/:postId/comments')
  })

  test('should warn that columns went unjudged when their table was not found', () => {
    const results = validatePlan(plan(), appState({ tables: [{ identifier: 'users', columns: ['id'] }] }))

    const result = expectResult(results, 'plan:app-unjudged', 'model.post', 'warn')
    expect(result?.message).toContain('table "posts" was not found')
    expect(find(results, 'plan:app-missing', 'column.post.id')).toBeUndefined()
  })

  test('should warn that columns went unjudged when the schema could not be read', () => {
    const results = validatePlan(plan(), appState({ tables: { unreadable: 'db/schema.ts declared no table' } }))

    const result = expectResult(results, 'plan:app-unjudged', 'model.post', 'warn')

    expect(result?.message).toContain("schema could not be read")
  })

  test('should not treat a middleware that merely starts with "can" as authorization', () => {
    const draft = plan()
    draft.controllers[0].actions[0].authorization.middleware = ['auth', 'cancelWindow']

    expectResult(validatePlan(draft, appState()), 'plan:route-authorization', 'route.comments.store', 'warn')
  })

  test('should treat a "can" alias as authorization', () => {
    const draft = plan()
    draft.controllers[0].actions[0].authorization.middleware = ['auth', 'can:create']

    expect(find(validatePlan(draft, appState()), 'plan:route-authorization', 'route.comments.store')).toBeUndefined()
  })

  test('should fail an altered action the plan states no route for', () => {
    const draft = plan()
    draft.controllers[0].change = { kind: 'alter' }
    draft.controllers[0].actions[0].change = { kind: 'alter' }
    draft.routes = draft.routes.filter((route) => route.action !== 'action.comments.store')
    draft.views[0].form = undefined
    draft.tasks[0].acceptance = []

    const result = expectResult(validatePlan(draft, appState()), 'plan:acceptance', 'action.comments.store', 'fail')

    expect(result?.message).toContain('states no route reaching it')
    expect(result?.suggestion).toContain('existing')
  })

  test('should fail an added action the controller already declares', () => {
    const results = validatePlan(plan(), appState({ actions: ['CommentController.store'] }))

    const result = expectResult(results, 'plan:app-collision', 'action.comments.store', 'fail')
    expect(result?.message).toContain('CommentController.store')
  })

  test('should fail an existing action no controller declares', () => {
    const draft = plan()
    draft.controllers[0].change = { kind: 'existing' }
    draft.controllers[0].actions[0].change = { kind: 'existing' }
    draft.controllers[0].actions[1].change = { kind: 'existing' }

    const results = validatePlan(draft, appState({ controllers: ['PostController', 'CommentController'] }))

    expect(find(results, 'plan:app-missing', 'action.comments.store')?.status).toBe('fail')
  })

  test('should not judge actions when the controller scan was partial', () => {
    const results = validatePlan(plan(), appState({ actions: { unreadable: '1 controller file did not parse' } }))

    expect(find(results, 'plan:app-collision', 'action.comments.store')).toBeUndefined()
    expect(find(results, 'plan:app-missing', 'action.comments.store')).toBeUndefined()
    expect(unreadableMessages(results).some((message) => message.includes('did not parse'))).toBe(true)
  })

  test('should treat a validator section a caller supplies as readable', () => {
    const results = validatePlan(plan(), appState({ validators: ['CommentPayloadSchema'] }))

    expectResult(results, 'plan:app-collision', 'validator.comment', 'fail')
  })

  test('should count an authentication middleware guren audit would count', () => {
    const draft = plan()
    draft.controllers[0].actions[1].authorization.middleware = ['sessionAuth']
    draft.controllers[0].actions[1].authorization.policy = undefined
    draft.routes[1].middleware = []

    expectResult(validatePlan(draft, appState()), 'plan:route-authorization', 'route.comments.destroy', 'warn')
  })

  test('should fail an altered model the application does not have', () => {
    const results = validatePlan(plan(), appState({ models: ['User'] }))

    const result = expectResult(results, 'plan:app-missing', 'model.post', 'fail')
    expect(result?.message).toContain('The model class "Post"')
  })

  test('should warn rather than fail for a column the table parser did not report', () => {
    const results = validatePlan(
      plan(),
      appState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title'] }] }),
    )

    const result = expectResult(results, 'plan:app-unjudged', 'column.post.id', 'warn')
    expect(result?.message).toContain('of table "posts"')
    expect(result?.message).toContain('lower bound')
    expect(find(results, 'plan:app-missing', 'column.post.id')).toBeUndefined()
  })

  test('should fail an added table the application already declares', () => {
    const results = validatePlan(
      plan(),
      appState({
        tables: [
          { identifier: 'posts', tableName: 'posts', columns: ['id'] },
          { identifier: 'comments', tableName: 'comments', columns: ['id'] },
        ],
      }),
    )

    const result = expectResult(results, 'plan:app-collision', 'model.comment', 'fail')
    expect(result?.message).toContain('The table "comments"')
  })

  test('should resolve a rename against its previous name, not its new one', () => {
    const draft = plan()
    draft.models[0].change = { kind: 'rename', from: 'Article' }
    draft.models[0].name = 'Post'

    const results = validatePlan(draft, appState({ models: ['Article', 'User'] }))

    expect(results.filter((entry) => entry.elementId === 'model.post' && entry.status === 'fail')).toEqual([])
  })

  test('should not judge a section the scanners could not read', () => {
    const results = validatePlan(plan(), appState({ models: { unreadable: 'app/Models would not open' } }))

    expect(find(results, 'plan:app-missing', 'model.post')).toBeUndefined()
    expect(find(results, 'plan:app-collision', 'model.comment')).toBeUndefined()
    expect(unreadableMessages(results).some((message) => message.includes('app/Models would not open'))).toBe(true)
  })

  test('should fail an added column under an existing model', () => {
    const draft = plan()
    draft.models[0].change = { kind: 'existing' }
    draft.models[0].columns[0].change = { kind: 'add' }

    const result = expectResult(validatePlan(draft, appState()), 'plan:change-consistency', 'column.post.id', 'fail')
    expect(result?.message).toContain('whose change is "existing"')
  })

  test('should fail an existing action under an added controller', () => {
    const draft = plan()
    draft.controllers[0].actions[0].change = { kind: 'existing' }

    expectResult(validatePlan(draft, appState()), 'plan:change-consistency', 'action.comments.store', 'fail')
  })

  test('should allow any column change under an altered model', () => {
    const draft = plan()
    draft.models[0].columns.push({
      ...draft.models[1].columns[1],
      id: 'column.post.excerpt',
      name: 'excerpt',
      dataMigration: { kind: 'none', reason: 'a new nullable column' },
    })
    draft.models[0].columns[1].nullable = true

    expect(find(validatePlan(draft, appState()), 'plan:change-consistency')).toBeUndefined()
  })

  test('should warn when an added model names a table Guren would not derive', () => {
    const draft = plan()
    draft.models[1].table = 'comment'

    const result = expectResult(validatePlan(draft, appState()), 'plan:inflection', 'model.comment', 'warn')
    expect(result?.message).toContain('"comments"')
  })

  test('should warn about a mutating authenticated route with no authorization', () => {
    const draft = plan()
    draft.controllers[0].actions[1].authorization.policy = undefined

    expectResult(validatePlan(draft, appState()), 'plan:route-authorization', 'route.comments.destroy', 'warn')
  })

  test('should warn about a body-carrying route with no body validator', () => {
    const draft = plan()
    draft.controllers[0].actions[0].body = undefined

    const result = expectResult(validatePlan(draft, appState()), 'plan:route-body', 'route.comments.store', 'warn')
    expect(result?.message).toContain('names no body validator')
  })

  test('should not ask a DELETE route for a body validator', () => {
    expect(find(validatePlan(plan(), appState()), 'plan:route-body', 'route.comments.destroy')).toBeUndefined()
  })

  test('should fail a dropped column on an existing table with no dataMigration', () => {
    const draft = plan()
    draft.models[0].columns[0].change = { kind: 'drop', reason: 'unused' }

    expectResult(validatePlan(draft, appState()), 'plan:data-migration', 'column.post.id', 'fail')
  })

  test('should accept a dataMigration of kind none', () => {
    const draft = plan()
    draft.models[0].columns[0].change = { kind: 'drop', reason: 'unused' }
    draft.models[0].columns[0].dataMigration = { kind: 'none', reason: 'the column was never written' }

    expect(find(validatePlan(draft, appState()), 'plan:data-migration', 'column.post.id')).toBeUndefined()
  })

  test('should fail a renamed table with no dataMigration', () => {
    const draft = plan()
    draft.models[0].tableRenamedFrom = 'articles'

    const result = expectResult(validatePlan(draft, appState()), 'plan:data-migration', 'model.post', 'fail')
    expect(result?.message).toContain('articles')
  })

  test('should warn about a drop and add pair that reads as a rename', () => {
    const draft = plan()
    draft.models[0].columns[0].change = { kind: 'drop', reason: 'replaced' }
    draft.models[0].columns[0].dataMigration = { kind: 'none', reason: 'the column was never written' }
    draft.models[0].columns.push({
      id: 'column.post.identifier',
      name: 'identifier',
      change: { kind: 'add' },
      type: 'integer',
      nullable: false,
      unique: false,
      index: false,
    })

    expectResult(validatePlan(draft, appState()), 'plan:rename-pair', 'column.post.identifier', 'warn')
  })

  test('should fail an altered action with no acceptance behaviour on its routes', () => {
    const draft = plan()
    draft.controllers[0].actions[1].change = { kind: 'alter' }
    draft.tasks[0].acceptance = draft.tasks[0].acceptance.filter(
      (behaviour) => behaviour.route !== 'route.comments.destroy',
    )

    expectResult(validatePlan(draft, appState()), 'plan:acceptance', 'action.comments.destroy', 'fail')
  })

  test('should warn about a validated route with no validation behaviour', () => {
    const draft = plan()
    draft.tasks[0].acceptance = draft.tasks[0].acceptance.filter((behaviour) => behaviour.kind !== 'validation')

    const result = validatePlan(draft, appState()).find(
      (entry) => entry.key === 'plan:acceptance' && entry.elementId === 'route.comments.store' && entry.message.includes('"validation"'),
    )

    expect(result?.status).toBe('warn')
  })

  test('should fail every view of an API-only application', () => {
    const results = validatePlan(plan(), appState({ apiOnly: true }))

    expectResult(results, 'plan:api-only-view', 'view.posts.show', 'fail')
  })
})

describe('flows', () => {
  function planWithFlow(nodes: unknown[], edges: unknown[]): PlanDraft {
    return PlanDraftSchema.parse({
      ...loadCommentsPlan(),
      flows: [{ id: 'flow.comment', change: { kind: 'add' }, title: 'Leaving a comment', nodes, edges }],
    })
  }

  const step = { id: 'form', label: 'The comment form', kind: 'page' }

  test('should accept a step naming an element the plan declares', () => {
    const results = validatePlan(
      planWithFlow([{ ...step, element: 'view.posts.show' }], []),
      appState(),
    )

    expect(find(failures(results), 'plan:reference', 'flow.comment')).toBeUndefined()
  })

  test('should accept a step that names no element, since an actor is not one', () => {
    const results = validatePlan(planWithFlow([{ id: 'reader', label: 'A reader', kind: 'actor' }], []), appState())

    expect(find(failures(results), 'plan:reference', 'flow.comment')).toBeUndefined()
  })

  test('should refuse a step naming an element the plan does not declare', () => {
    const results = validatePlan(planWithFlow([{ ...step, element: 'view.nowhere' }], []), appState())

    expect(expectResult(results, 'plan:reference', 'flow.comment', 'fail').message).toContain('view.nowhere')
  })

  test('should say when a step loops to itself, which the layout cannot draw', () => {
    const results = validatePlan(planWithFlow([step], [{ from: 'form', to: 'form' }]), appState())

    expect(expectResult(results, 'plan:flow-self-loop', 'flow.comment', 'warn').message).toContain('form')
  })

  test('should refuse an edge naming a step this flow does not have', () => {
    const results = validatePlan(planWithFlow([step], [{ from: 'form', to: 'nowhere' }]), appState())

    expect(expectResult(results, 'plan:reference', 'flow.comment', 'fail').message).toContain('no step of this flow')
  })

  test('should refuse an edge naming a plan element rather than a step of the flow', () => {
    // `route.comments.store` is a real element of this plan, which says nothing about
    // whether the flow has a step by that name. Only the flow's own steps are edge ends.
    const results = validatePlan(planWithFlow([step], [{ from: 'form', to: 'route.comments.store' }]), appState())

    expect(expectResult(results, 'plan:reference', 'flow.comment', 'fail').message).toContain('no step of this flow')
  })

  test('should refuse a step id declared twice in one flow', () => {
    const results = validatePlan(
      planWithFlow([step, { ...step, label: 'The same id again' }], []),
      appState(),
    )

    expect(expectResult(results, 'plan:reference', 'flow.comment', 'fail').message).toContain('declared twice')
  })

  test('should accept the same step id in two different flows', () => {
    const plan = PlanDraftSchema.parse({
      ...loadCommentsPlan(),
      flows: [
        { id: 'flow.one', change: { kind: 'add' }, title: 'One', nodes: [step], edges: [] },
        { id: 'flow.two', change: { kind: 'add' }, title: 'Two', nodes: [step], edges: [] },
      ],
    })

    expect(failures(validatePlan(plan, appState())).filter((r) => r.key === 'plan:reference')).toEqual([])
  })

  test.each([
    ['route', 'route.comments.store'],
    ['action', 'action.comments.store'],
    ['page', 'view.posts.show'],
  ])('should accept a %s step naming an element of that section', (kind, element) => {
    const results = validatePlan(planWithFlow([{ ...step, kind, element }], []), appState())

    expect(find(failures(results), 'plan:reference', 'flow.comment')).toBeUndefined()
  })

  test('should refuse a route step that names a view', () => {
    const results = validatePlan(
      planWithFlow([{ ...step, kind: 'route', element: 'view.posts.show' }], []),
      appState(),
    )

    expect(expectResult(results, 'plan:reference', 'flow.comment', 'fail').message).toContain('is a views element')
  })

  test.each([
    // The pairs the comment on FLOW_KIND_SECTIONS claims are legitimate, so the test
    // says what the freedom is for rather than only that it exists.
    ['store', 'model.comment'],
    ['store', 'resource.comment'],
    ['decision', 'validator.comment'],
    ['decision', 'policy.comment'],
    ['job', 'route.comments.store'],
    ['actor', 'model.comment'],
    ['external', 'route.comments.destroy'],
  ])('should leave a %s step free to name %s, since its kind names no section', (kind, element) => {
    const results = validatePlan(planWithFlow([{ ...step, kind, element }], []), appState())

    expect(find(failures(results), 'plan:reference', 'flow.comment')).toBeUndefined()
  })

  test('should judge an edge against its own flow, since a step id is the flow\'s own', () => {
    const plan = PlanDraftSchema.parse({
      ...loadCommentsPlan(),
      flows: [
        { id: 'flow.one', change: { kind: 'add' }, title: 'One', nodes: [step], edges: [] },
        {
          id: 'flow.two',
          change: { kind: 'add' },
          title: 'Two',
          nodes: [{ id: 'other', label: 'Other', kind: 'page' }],
          // `form` is a step of flow.one, which says nothing about flow.two.
          edges: [{ from: 'other', to: 'form' }],
        },
      ],
    })

    const results = validatePlan(plan, appState())

    expect(find(failures(results), 'plan:reference', 'flow.one')).toBeUndefined()
    expect(expectResult(results, 'plan:reference', 'flow.two', 'fail').message).toContain('"form"')
  })
})
