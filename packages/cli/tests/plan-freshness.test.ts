import { describe, expect, test } from 'bun:test'

import { listPlanAppTargets } from '../src/plan/app-targets'
import { judgeFreshness, stampContextHash, type PlanFreshness } from '../src/plan/freshness'
import { PlanDraftSchema, PlanSchema, type Plan, type PlanDraft } from '../src/plan/schema'
import type { PlanElementState } from '../src/plan/status'
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

/** Every element at one state, as plan:status would report a plan nobody has started. */
function statesOf(plan: PlanDraft, state: PlanElementState = 'planned', overrides: Record<string, PlanElementState> = {}) {
  return listPlanAppTargets(plan).map((target) => ({ id: target.id, state: overrides[target.id] ?? state }))
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
    expect(unstamped).toContainEqual({ id: 'model.post', reason: "the application's tables could not be read (schema threw)" })
    // Validators are never readable: no scanner resolves an exported schema symbol.
    expect(unstamped.map((entry) => entry.id)).toContain('validator.comment')
    expect(contextHash['controller.comments']).toBeDefined()
  })

  test('should derive its targets from the same place the reference checks do', () => {
    const plan = draft()
    const empty = planAppState({ models: [], controllers: [], actions: [], resources: [], policies: [], pages: [], validators: [], routes: [], tables: [] })
    const targets = new Set(listPlanAppTargets(plan).map((target) => target.id))
    const judged = validatePlan(plan, empty)
      .filter((result) => result.key === 'plan:app-missing' || result.key === 'plan:app-collision')
      .map((result) => result.elementId)
    expect(judged.length).toBeGreaterThan(0)
    for (const id of judged) expect(targets.has(id!)).toBe(true)
  })
})

describe('judgeFreshness', () => {
  test('should call every stamped element fresh against the application it was stamped against', () => {
    const plan = approvedAgainst(draft())
    const freshness = judgeFreshness(plan, planAppState(), statesOf(plan))
    expect(freshness.summary.stale).toBe(0)
    expect(freshness.summary.unstamped).toBe(0)
    expect(verdictOf(freshness, 'model.post')).toEqual({ id: 'model.post', section: 'models', change: 'alter', verdict: 'fresh' })
    expect(verdictOf(freshness, 'validator.comment').verdict).toBe('unjudged')
  })

  test('should mark a referenced element stale when what the scanners read for it changed, and name what depends on it', () => {
    const plan = approvedAgainst(draft())
    const freshness = judgeFreshness(plan, planAppState({ models: [{ name: 'Post', module: 'blog' }, 'User'] }), statesOf(plan))

    const post = verdictOf(freshness, 'model.post')
    expect(post.verdict).toBe('stale')
    // Every element naming it: the relationship, the foreign key, the route binding, the task covering it.
    expect(post.affects).toEqual(['model.comment', 'column.comment.postId', 'route.comments.store', 'task.comments'])
    expect(post.affects).not.toContain('model.post')
    expect(freshness.summary.stale).toBe(1)
  })

  test('should not call an added element stale once the plan implemented it, and should while it is still planned', () => {
    const plan = approvedAgainst(draft())
    const implemented = planAppState({ models: ['Comment', 'Post', 'User'], tables: [...PLAN_APP_TABLES, { identifier: 'comments', tableName: 'comments', columns: ['id', 'body', 'postId'] }] })

    const done = judgeFreshness(plan, implemented, statesOf(plan, 'planned', { 'model.comment': 'present' }))
    expect(verdictOf(done, 'model.comment')).toMatchObject({ verdict: 'fresh', reason: "Its context changed with the plan's own work (present)." })

    // Someone else's Comment, landed while the plan's own step has not run: the collision is news.
    const notYet = judgeFreshness(plan, implemented, statesOf(plan))
    expect(verdictOf(notYet, 'model.comment').verdict).toBe('stale')
    // Neither is a state that says the element exists, so neither excuses a difference.
    for (const state of ['blocked', 'unjudged'] as const) {
      expect(verdictOf(judgeFreshness(plan, implemented, statesOf(plan, 'planned', { 'model.comment': state })), 'model.comment').verdict).toBe('stale')
    }
  })

  test('should call a changed existing element stale whatever its status says', () => {
    const plan = approvedAgainst(draft())
    const changed = planAppState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title', 'body'] }, PLAN_APP_TABLES[1]!] })
    const freshness = judgeFreshness(plan, changed, statesOf(plan, 'present'))
    expect(verdictOf(freshness, 'column.post.id')).toMatchObject({ change: 'existing', verdict: 'stale' })
  })

  test('should report an element with no stamp as unstamped, and an unreadable section as unjudged, never fresh', () => {
    const plan = approvedAgainst(draft(), { tables: { unreadable: 'schema threw' } })

    const readable = judgeFreshness(plan, planAppState(), statesOf(plan))
    expect(verdictOf(readable, 'model.post').verdict).toBe('unstamped')
    expect(verdictOf(readable, 'column.post.id').verdict).toBe('unstamped')

    const unreadable = judgeFreshness(plan, planAppState({ tables: { unreadable: 'still threw' } }), statesOf(plan))
    expect(verdictOf(unreadable, 'model.post')).toMatchObject({ verdict: 'unjudged', reason: "the application's tables could not be read (still threw)" })
    expect(unreadable.elements.filter((element) => element.verdict === 'fresh').map((element) => element.id)).not.toContain('model.post')
  })

  test('should report an element a revision added after approval as unstamped, the baseline left as its parent had it', () => {
    const parent = approvedAgainst(draft())
    const revised = PlanSchema.parse({
      ...draft((document) => {
        ;(document.resources as Array<Record<string, unknown>>).push({ id: 'resource.post', change: { kind: 'existing' }, name: 'PostResource', model: 'model.post', fields: [] })
      }),
      baseline: parent.baseline,
    })
    const freshness = judgeFreshness(revised, planAppState(), statesOf(revised))
    expect(verdictOf(freshness, 'resource.post').verdict).toBe('unstamped')
    expect(freshness.summary.stale).toBe(0)
  })

  test('should keep the existing columns of a table the plan renames fresh once the rename is done', () => {
    const plan = approvedAgainst(
      draft((document) => {
        const post = (document.models as Array<Record<string, unknown>>)[0]!
        post.table = 'articles'
        post.tableRenamedFrom = 'posts'
      }),
    )
    const renamed = planAppState({ tables: [{ identifier: 'articles', tableName: 'articles', columns: ['id', 'title', 'body'] }, PLAN_APP_TABLES[1]!] })
    const freshness = judgeFreshness(plan, renamed, statesOf(plan, 'planned', { 'model.post': 'present' }))
    expect(verdictOf(freshness, 'column.post.id').verdict).toBe('fresh')
    expect(verdictOf(freshness, 'model.post').verdict).toBe('fresh')
  })

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
    const freshness = judgeFreshness(plan, renamed, statesOf(plan, 'planned', { 'controller.posts': 'present' }))
    expect(verdictOf(freshness, 'action.posts.index').verdict).toBe('fresh')
    // The action leaving the application altogether is still news.
    const gone = judgeFreshness(plan, planAppState({ controllers: ['ArticleController'], actions: [] }), statesOf(plan, 'planned', { 'controller.posts': 'present' }))
    expect(verdictOf(gone, 'action.posts.index').verdict).toBe('stale')
  })
})
