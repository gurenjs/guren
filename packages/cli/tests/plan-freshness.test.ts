import { describe, expect, test } from 'bun:test'

import { listPlanAppTargets } from '../src/plan/app-targets'
import { judgeFreshness, stampContextHash, type PlanFreshness } from '../src/plan/freshness'
import { PlanDraftSchema, PlanSchema, type Plan, type PlanDraft } from '../src/plan/schema'
import { validatePlan } from '../src/plan/validate'
import { loadCommentsPlan, PLAN_APP_TABLES, planAppState, type PlanAppStateInput } from './plan-fixture'

function draft(edit?: (document: Record<string, unknown>) => void): PlanDraft {
  const document = loadCommentsPlan()
  edit?.(document)
  return PlanDraftSchema.parse(document)
}

/** The draft approved against `at`: its baseline stamped the way `plan:approve` stamps it. */
function approvedAgainst(plan: PlanDraft, at: PlanAppStateInput = {}): Plan {
  return PlanSchema.parse({ ...plan, baseline: { rev: 'abc123', contextHash: stampContextHash(plan, planAppState(at)).contextHash } })
}

function verdictOf(freshness: PlanFreshness, id: string) {
  const element = freshness.elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`no freshness verdict for ${id}`)
  return element
}

describe('stampContextHash', () => {
  test('should hash every element the reference checks judge by name, and one entry per model', () => {
    const plan = draft()
    const { contextHash, unstamped } = stampContextHash(plan, planAppState())

    const judged = [...new Set(listPlanAppTargets(plan).map((target) => target.id))]
    expect([...Object.keys(contextHash), ...unstamped.map((entry) => entry.id)].sort()).toEqual(judged.sort())
    expect(contextHash['model.post']).toMatch(/^[0-9a-f]{64}$/)
    expect(contextHash['column.post.id']).toBeDefined()
    // An added model's columns are judged by nobody: no table can hold them yet.
    expect(contextHash['column.comment.body']).toBeUndefined()
    expect(judged).not.toContain('column.comment.body')
  })

  test('should stamp the same bytes for the same application whatever order the scanners listed it in', () => {
    const plan = draft()
    const first = stampContextHash(plan, planAppState())
    const reordered = stampContextHash(plan, planAppState({ models: ['User', 'Post'], tables: [...PLAN_APP_TABLES].reverse() }))
    expect(reordered).toEqual(first)
    expect(stampContextHash(plan, planAppState())).toEqual(first)
  })

  test('should leave every hash alone when the application changes somewhere the plan does not reference', () => {
    const plan = draft()
    const before = stampContextHash(plan, planAppState())
    const after = stampContextHash(
      plan,
      planAppState({
        models: ['Post', 'User', 'Tag'],
        controllers: ['PostController', 'TagController'],
        tables: [...PLAN_APP_TABLES, { identifier: 'tags', tableName: 'tags', columns: ['id', 'name'] }],
        routes: [
          { name: 'posts.index', method: 'GET', path: '/posts' },
          { name: 'posts.show', method: 'GET', path: '/posts/:id' },
          { name: 'tags.index', method: 'GET', path: '/tags' },
        ],
      }),
    )
    expect(after).toEqual(before)
  })

  test('should not move a model whose table gains a column, since columns are entries of their own', () => {
    const plan = draft()
    const before = stampContextHash(plan, planAppState()).contextHash
    const after = stampContextHash(plan, planAppState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['id', 'title', 'body', 'slug'] }, PLAN_APP_TABLES[1]!] })).contextHash
    expect(after['model.post']).toBe(before['model.post']!)
  })

  test('should stamp nothing for an element whose section could not be read, never hashing it as empty', () => {
    const plan = draft()
    const { contextHash, unstamped } = stampContextHash(plan, planAppState({ tables: { unreadable: 'schema threw' } }))

    // A model is judged by its class and its table, so it goes unstamped with its columns.
    expect(contextHash['model.post']).toBeUndefined()
    expect(contextHash['column.post.id']).toBeUndefined()
    expect(unstamped).toContainEqual({ id: 'model.post', sections: ['tables'], reason: "the application's tables could not be read (schema threw)" })
    // Validators are never readable: no scanner resolves an exported schema symbol.
    expect(unstamped.map((entry) => entry.id)).toContain('validator.comment')
    expect(contextHash['controller.comments']).toBeDefined()
  })

  test('should stamp exactly the elements the reference checks judge against the application by name', () => {
    const plan = draft()
    // Against an application with nothing, every non-add is missing; against one declaring every
    // name the plan uses, every add collides. Between them, each judged element is reported once.
    const empty = planAppState({ models: [], controllers: [], actions: [], resources: [], policies: [], pages: [], validators: [], routes: [], tables: [] })
    const targets = listPlanAppTargets(plan)
    const full = planAppState({
      models: plan.models.map((model) => model.name),
      controllers: plan.controllers.map((controller) => controller.className),
      actions: targets.filter((target) => target.appSection === 'actions').map((target) => target.current),
      resources: plan.resources.map((resource) => resource.name),
      policies: plan.policies.map((policy) => policy.name),
      pages: plan.views.map((view) => view.page),
      validators: plan.validators.map((validator) => validator.name),
      routes: plan.routes.map((route) => ({ name: route.name, method: route.method, path: route.path })),
      tables: plan.models.map((model) => ({ identifier: model.table, tableName: model.table, columns: [] })),
    })
    const judged = new Set(
      [...validatePlan(plan, empty), ...validatePlan(plan, full)]
        .filter((result) => ['plan:app-missing', 'plan:app-collision', 'plan:app-unjudged'].includes(result.key) && result.elementId !== undefined)
        .map((result) => result.elementId!),
    )
    expect([...judged].sort()).toEqual([...new Set(targets.map((target) => target.id))].sort())
  })
})

describe('judgeFreshness', () => {
  test('should call every stamped element fresh against the application it was stamped against', () => {
    const plan = approvedAgainst(draft())
    const freshness = judgeFreshness(plan, planAppState())
    expect(freshness.summary.stale).toBe(0)
    expect(freshness.summary.unstamped).toBe(0)
    expect(verdictOf(freshness, 'model.post')).toEqual({ id: 'model.post', section: 'models', change: 'alter', verdict: 'fresh' })
    expect(verdictOf(freshness, 'validator.comment').verdict).toBe('unjudged')
  })

  test('should mark a referenced element stale when what the scanners read for it changed, and name what depends on it', () => {
    const plan = approvedAgainst(draft())
    const freshness = judgeFreshness(plan, planAppState({ models: [{ name: 'Post', module: 'blog' }, 'User'] }))

    const post = verdictOf(freshness, 'model.post')
    expect(post.verdict).toBe('stale')
    // Every element naming it: the relationship, the foreign key, the route binding, the task covering it.
    expect(post.affects).toEqual(['model.comment', 'column.comment.postId', 'route.comments.store', 'task.comments'])
    expect(freshness.summary.stale).toBe(1)
  })

  test('should call an added element fresh once the application holds it where the plan puts it', () => {
    const plan = approvedAgainst(draft())
    const implemented = planAppState({ models: ['Comment', 'Post', 'User'], tables: [...PLAN_APP_TABLES, { identifier: 'comments', tableName: 'comments', columns: ['id', 'body', 'postId'] }] })

    const freshness = judgeFreshness(plan, implemented)
    expect(verdictOf(freshness, 'model.comment')).toMatchObject({ verdict: 'fresh', reason: 'The application reads as the plan leaves it.' })
    // Half of it is neither the stamp nor the end: the class without its table.
    const half = judgeFreshness(plan, planAppState({ models: ['Comment', 'Post', 'User'] }))
    expect(verdictOf(half, 'model.comment').verdict).toBe('stale')
  })

  test('should read a same-root class the plan adds as the plan own, whoever wrote it', () => {
    // Documented (RFC 0030 §4): someone else's Comment in the plan's root after approval
    // reads exactly as the plan's own add, before its step has run as much as after.
    const plan = approvedAgainst(draft())
    const freshness = judgeFreshness(plan, planAppState({ models: ['Comment', 'Post', 'User'], tables: [...PLAN_APP_TABLES, { identifier: 'comments', tableName: 'comments', columns: [] }] }))
    expect(verdictOf(freshness, 'model.comment').verdict).toBe('fresh')
  })

  test('should call an added table stale when another app root declares its name, which the shared schema makes a collision', () => {
    const plan = approvedAgainst(draft())
    const implemented = [...PLAN_APP_TABLES, { identifier: 'comments', tableName: 'comments', columns: ['id'] }]
    const collided = planAppState({
      models: ['Comment', 'Post', 'User'],
      tables: [...implemented, { identifier: 'comments', tableName: 'comments', columns: ['id'], module: 'billing' }],
    })
    expect(verdictOf(judgeFreshness(plan, collided), 'model.comment').verdict).toBe('stale')
  })

  test('should call an altered route stale when another commit moves its path', () => {
    const plan = approvedAgainst(
      draft((document) => {
        ;(document.controllers as Array<Record<string, unknown>>).push({
          id: 'controller.posts',
          change: { kind: 'existing' },
          className: 'PostController',
          actions: [{ id: 'action.posts.index', change: { kind: 'existing' }, name: 'index', authorization: { middleware: [] }, response: { kind: 'json', description: 'the posts' }, rules: [] }],
        })
        ;(document.routes as Array<Record<string, unknown>>).push({
          id: 'route.posts.index',
          change: { kind: 'alter' },
          method: 'GET',
          path: '/posts',
          name: 'posts.index',
          action: 'action.posts.index',
          middleware: ['auth'],
          bind: [],
        })
      }),
    )
    const moved = planAppState({ routes: [{ name: 'posts.index', method: 'GET', path: '/p' }, { name: 'posts.show', method: 'GET', path: '/posts/:id' }] })
    expect(verdictOf(judgeFreshness(plan, moved), 'route.posts.index')).toMatchObject({ change: 'alter', verdict: 'stale' })
    expect(verdictOf(judgeFreshness(plan, planAppState()), 'route.posts.index').verdict).toBe('fresh')
  })

  test('should call a changed existing element stale', () => {
    const plan = approvedAgainst(draft())
    const changed = planAppState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title', 'body'] }, PLAN_APP_TABLES[1]!] })
    expect(verdictOf(judgeFreshness(plan, changed), 'column.post.id')).toMatchObject({ change: 'existing', verdict: 'stale' })
  })

  test('should call the existing children of a dropped model fresh once the drop lands, and stale while only they vanish', () => {
    const plan = approvedAgainst(
      draft((document) => {
        const post = (document.models as Array<Record<string, unknown>>)[0]!
        post.change = { kind: 'drop', reason: 'posts are retired' }
      }),
    )
    const dropped = judgeFreshness(plan, planAppState({ models: ['User'], tables: [PLAN_APP_TABLES[1]!] }))
    expect(verdictOf(dropped, 'model.post').verdict).toBe('fresh')
    expect(verdictOf(dropped, 'column.post.id')).toMatchObject({ change: 'existing', verdict: 'fresh' })

    const columnGone = judgeFreshness(plan, planAppState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title'] }, PLAN_APP_TABLES[1]!] }))
    expect(verdictOf(columnGone, 'column.post.id').verdict).toBe('stale')
  })

  test('should call the existing actions of a dropped controller fresh once the drop lands', () => {
    const plan = approvedAgainst(
      draft((document) => {
        ;(document.controllers as Array<Record<string, unknown>>).push({
          id: 'controller.posts',
          change: { kind: 'drop', reason: 'posts are retired' },
          className: 'PostController',
          actions: [{ id: 'action.posts.index', change: { kind: 'existing' }, name: 'index', authorization: { middleware: [] }, response: { kind: 'json', description: 'the posts' }, rules: [] }],
        })
      }),
    )
    const dropped = judgeFreshness(plan, planAppState({ controllers: [], actions: [] }))
    expect(verdictOf(dropped, 'action.posts.index').verdict).toBe('fresh')
    expect(verdictOf(dropped, 'controller.posts').verdict).toBe('fresh')
  })

  test('should report an element with no stamp as unstamped, and an unreadable section as unjudged, never fresh', () => {
    const plan = approvedAgainst(draft(), { tables: { unreadable: 'schema threw' } })

    const readable = judgeFreshness(plan, planAppState())
    expect(verdictOf(readable, 'model.post').verdict).toBe('unstamped')
    expect(verdictOf(readable, 'column.post.id').verdict).toBe('unstamped')

    const unreadable = judgeFreshness(plan, planAppState({ tables: { unreadable: 'still threw' } }))
    expect(verdictOf(unreadable, 'model.post')).toMatchObject({ verdict: 'unjudged', reason: "the application's tables could not be read (still threw)" })
  })

  test('should report an element a revision added after approval as unstamped, the baseline left as its parent had it', () => {
    const parent = approvedAgainst(draft())
    const revised = PlanSchema.parse({
      ...draft((document) => {
        ;(document.resources as Array<Record<string, unknown>>).push({ id: 'resource.post', change: { kind: 'existing' }, name: 'PostResource', model: 'model.post', fields: [] })
      }),
      baseline: parent.baseline,
    })
    const freshness = judgeFreshness(revised, planAppState())
    expect(verdictOf(freshness, 'resource.post').verdict).toBe('unstamped')
    expect(freshness.summary.stale).toBe(0)
  })

  for (const change of ['alter', 'existing'] as const) {
    test(`should keep an ${change} model whose table the plan renames, and its existing columns, fresh once the rename is done`, () => {
      const plan = approvedAgainst(
        draft((document) => {
          const post = (document.models as Array<Record<string, unknown>>)[0]!
          post.change = { kind: change }
          post.table = 'articles'
          post.tableRenamedFrom = 'posts'
          post.dataMigration = { kind: 'none', reason: 'a rename keeps the rows' }
          if (change === 'existing') post.relationships = []
        }),
      )
      const renamed = planAppState({ tables: [{ identifier: 'articles', tableName: 'articles', columns: ['id', 'title', 'body'] }, PLAN_APP_TABLES[1]!] })
      const freshness = judgeFreshness(plan, renamed)
      expect(verdictOf(freshness, 'column.post.id').verdict).toBe('fresh')
      expect(verdictOf(freshness, 'model.post').verdict).toBe('fresh')
      // Both names at once is neither the stamp nor what the rename leaves.
      const both = planAppState({ tables: [...PLAN_APP_TABLES, { identifier: 'articles', tableName: 'articles', columns: ['id'] }] })
      expect(verdictOf(judgeFreshness(plan, both), 'model.post').verdict).toBe('stale')
    })
  }

  test('should keep the existing actions of a controller the plan renames fresh once the rename is done', () => {
    const plan = approvedAgainst(
      draft((document) => {
        ;(document.controllers as Array<Record<string, unknown>>).push({
          id: 'controller.posts',
          change: { kind: 'rename', from: 'PostController' },
          className: 'ArticleController',
          actions: [{ id: 'action.posts.index', change: { kind: 'existing' }, name: 'index', authorization: { middleware: [] }, response: { kind: 'json', description: 'the posts' }, rules: [] }],
        })
      }),
    )
    const renamed = planAppState({ controllers: ['ArticleController'], actions: ['ArticleController.index', 'ArticleController.show'] })
    expect(verdictOf(judgeFreshness(plan, renamed), 'action.posts.index').verdict).toBe('fresh')
    // The action leaving the application altogether is still news.
    expect(verdictOf(judgeFreshness(plan, planAppState({ controllers: ['ArticleController'], actions: [] })), 'action.posts.index').verdict).toBe('stale')
  })
})
