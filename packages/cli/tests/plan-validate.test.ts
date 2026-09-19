import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import type { PlanAppState } from '../src/plan/app-state'
import { validatePlan, type PlanCheckResult } from '../src/plan/validate'

function plan(): PlanDraft {
  return PlanDraftSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')),
  )
}

/** An application the comments fixture is a clean delta against. */
function appState(overrides: Partial<PlanAppState> = {}): PlanAppState {
  return {
    models: ['Post', 'User'],
    controllers: ['PostController'],
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

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'route.comments.store')

    expect(result?.status).toBe('fail')
    expect(result?.message).toContain('action.comments.missing')
  })

  test('should fail an action whose response page is not a view', () => {
    const draft = plan()
    draft.controllers[0].actions[0].response = { kind: 'inertia', view: 'view.posts.missing' }

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'action.comments.store')

    expect(result?.status).toBe('fail')
    expect(result?.message).toContain('view.posts.missing')
  })

  test('should fail a form field that names no field of its validator', () => {
    const draft = plan()
    draft.views[0].form!.fields[0].field = 'title'

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'view.posts.show')

    expect(result?.message).toContain('The form field "title"')
  })

  test('should fail a foreign key to a model the plan does not declare', () => {
    const draft = plan()
    draft.models[1].columns[2].references!.model = 'model.author'

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'column.comment.postId')

    expect(result?.status).toBe('fail')
  })

  test('should fail a question affecting an id no element declares', () => {
    const draft = plan()
    draft.questions[0].affects.push('model.ghost')

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'Q-delete')

    expect(result?.message).toContain('model.ghost')
  })

  test('should fail a task covering an id no element declares', () => {
    const draft = plan()
    draft.tasks[0].covers.push('view.ghost')

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'task.comments')

    expect(result?.message).toContain('view.ghost')
  })

  test('should fail an acceptance behaviour naming an unknown route', () => {
    const draft = plan()
    draft.tasks[0].acceptance[0].route = 'route.comments.patch'

    const result = find(validatePlan(draft, appState()), 'plan:reference', 'AC-comments-1')

    expect(result?.status).toBe('fail')
  })

  test('should fail a duplicated id', () => {
    const draft = plan()
    draft.resources[0].id = 'policy.comment'

    const result = find(validatePlan(draft, appState()), 'plan:duplicate-id', 'policy.comment')

    expect(result?.status).toBe('fail')
  })

  test('should fail an added model whose class the application already has', () => {
    const draft = plan()
    const results = validatePlan(draft, appState({ models: ['Post', 'User', 'Comment'] }))

    const result = find(results, 'plan:app-collision', 'model.comment')

    expect(result?.message).toContain('The model class "Comment"')
  })

  test('should fail an added route whose name the application already has', () => {
    const results = validatePlan(
      plan(),
      appState({ routes: [{ name: 'comments.store', method: 'POST', path: '/comments' }] }),
    )

    const result = find(results, 'plan:app-collision', 'route.comments.store')

    expect(result?.message).toContain('The route name "comments.store"')
  })

  test('should fail an added route whose method and path the application already registers', () => {
    const results = validatePlan(
      plan(),
      appState({ routes: [{ name: 'posts.comment', method: 'POST', path: '/posts/:postId/comments' }] }),
    )

    const result = find(results, 'plan:app-collision', 'route.comments.store')

    expect(result?.message).toContain('POST /posts/:postId/comments')
  })

  test('should warn that columns went unjudged when their table was not found', () => {
    const results = validatePlan(plan(), appState({ tables: [{ identifier: 'users', columns: ['id'] }] }))

    const result = find(results, 'plan:app-unjudged', 'model.post')

    expect(result?.status).toBe('warn')
    expect(result?.message).toContain('Table "posts" was not found')
  })

  test('should fail an altered model the application does not have', () => {
    const results = validatePlan(plan(), appState({ models: ['User'] }))

    const result = find(results, 'plan:app-missing', 'model.post')

    expect(result?.message).toContain('The model class "Post"')
  })

  test('should fail an existing column the application table does not declare', () => {
    const results = validatePlan(
      plan(),
      appState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title'] }] }),
    )

    const result = find(results, 'plan:app-missing', 'column.post.id')

    expect(result?.message).toContain('of table "posts"')
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

    const result = find(results, 'plan:app-collision', 'model.comment')

    expect(result?.message).toContain('The table "comments"')
  })

  test('should resolve a rename against its previous name, not its new one', () => {
    const draft = plan()
    draft.models[0].change = { kind: 'rename', from: 'Article' }
    draft.models[0].name = 'Post'

    const results = validatePlan(draft, appState({ models: ['Article', 'User'] }))

    expect(find(results, 'plan:app-missing', 'model.post')).toBeUndefined()
  })

  test('should not judge a section the scanners could not read', () => {
    const results = validatePlan(plan(), appState({ models: { unreadable: 'app/Models would not open' } }))

    expect(find(results, 'plan:app-missing', 'model.post')).toBeUndefined()
    expect(find(results, 'plan:app-collision', 'model.comment')).toBeUndefined()
    expect(find(results, 'plan:app-unreadable')?.message).toContain('app/Models would not open')
  })

  test('should fail an added column under an existing model', () => {
    const draft = plan()
    draft.models[0].change = { kind: 'existing' }
    draft.models[0].columns[0].change = { kind: 'add' }

    const result = find(validatePlan(draft, appState()), 'plan:change-consistency', 'column.post.id')

    expect(result?.message).toContain('whose change is "existing"')
  })

  test('should fail an existing action under an added controller', () => {
    const draft = plan()
    draft.controllers[0].actions[0].change = { kind: 'existing' }

    const result = find(validatePlan(draft, appState()), 'plan:change-consistency', 'action.comments.store')

    expect(result?.status).toBe('fail')
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

    const result = find(validatePlan(draft, appState()), 'plan:inflection', 'model.comment')

    expect(result?.status).toBe('warn')
    expect(result?.message).toContain('"comments"')
  })

  test('should warn about a mutating authenticated route with no authorization', () => {
    const draft = plan()
    draft.controllers[0].actions[1].authorization.policy = undefined

    const result = find(validatePlan(draft, appState()), 'plan:route-authorization', 'route.comments.destroy')

    expect(result?.status).toBe('warn')
  })

  test('should warn about a body-carrying route with no body validator', () => {
    const draft = plan()
    draft.controllers[0].actions[0].body = undefined

    const result = find(validatePlan(draft, appState()), 'plan:route-body', 'route.comments.store')

    expect(result?.message).toContain('names no body validator')
  })

  test('should not ask a DELETE route for a body validator', () => {
    expect(find(validatePlan(plan(), appState()), 'plan:route-body', 'route.comments.destroy')).toBeUndefined()
  })

  test('should fail a dropped column on an existing table with no dataMigration', () => {
    const draft = plan()
    draft.models[0].columns[0].change = { kind: 'drop', reason: 'unused' }

    const result = find(validatePlan(draft, appState()), 'plan:data-migration', 'column.post.id')

    expect(result?.status).toBe('fail')
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

    const result = find(validatePlan(draft, appState()), 'plan:data-migration', 'model.post')

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

    const result = find(validatePlan(draft, appState()), 'plan:rename-pair', 'column.post.identifier')

    expect(result?.status).toBe('warn')
  })

  test('should fail an altered action with no acceptance behaviour on its routes', () => {
    const draft = plan()
    draft.controllers[0].actions[1].change = { kind: 'alter' }
    draft.tasks[0].acceptance = draft.tasks[0].acceptance.filter(
      (behaviour) => behaviour.route !== 'route.comments.destroy',
    )

    const result = find(validatePlan(draft, appState()), 'plan:acceptance', 'action.comments.destroy')

    expect(result?.status).toBe('fail')
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

    const result = find(results, 'plan:api-only-view', 'view.posts.show')

    expect(result?.status).toBe('fail')
  })
})
