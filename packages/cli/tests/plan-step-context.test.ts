import { describe, expect, test } from 'bun:test'

import { parsePlanDocument } from '../src/plan-render'
import type { PlanElementFreshness, PlanFreshness } from '../src/plan/freshness'
import { judgeStepContext, stepInProgress } from '../src/plan/step-context'
import { derivePlanTasks } from '../src/plan/tasks'
import { loadCommentsPlan } from './plan-fixture'

const COMMENT = 'task/entity/model.comment'
const DATA = `${COMMENT}/data`
const HTTP = `${COMMENT}/http`
const PAGES = `${COMMENT}/pages`

/** The comments fixture with an `existing` PostController holding an added action. */
function plan() {
  const document = loadCommentsPlan() as Record<string, Array<Record<string, unknown>>>
  document.controllers!.push({
    id: 'controller.posts',
    change: { kind: 'existing' },
    className: 'PostController',
    actions: [{ id: 'action.posts.feed', change: { kind: 'add' }, name: 'feed', authorization: { middleware: [] }, response: { kind: 'json', description: 'the feed' }, rules: [] }],
  })
  return parsePlanDocument(document)
}

function freshness(elements: Array<Partial<PlanElementFreshness> & Pick<PlanElementFreshness, 'id' | 'verdict'>>): PlanFreshness {
  const full = elements.map((element) => ({ section: 'models', change: 'alter', ...element }) as PlanElementFreshness)
  return { elements: full, summary: { fresh: 0, stale: 0, unstamped: 0, unjudged: 0 } }
}

function staleOf(contexts: ReturnType<typeof judgeStepContext>): Record<string, string[]> {
  return Object.fromEntries([...contexts].filter(([, context]) => context.stale.length > 0).map(([id, context]) => [id, context.stale.map((element) => element.id)]))
}

describe('judgeStepContext', () => {
  const PLAN = plan()
  const DERIVATION = derivePlanTasks(PLAN)

  test('should hold the owner and the steps whose own elements name the stale element, one hop and no further', () => {
    // The pages step's view names the comment resource, two hops from model.post, so it is not held.
    const contexts = judgeStepContext(PLAN, freshness([{ id: 'model.post', verdict: 'stale', affects: ['model.comment', 'route.comments.store', 'task.comments'] }]), DERIVATION)

    expect(staleOf(contexts)).toEqual({ [DATA]: ['model.post'], [HTTP]: ['model.post'] })
    expect(contexts.get(DATA)!.stale[0]).toMatchObject({ owned: true, through: ['model.comment'], within: [] })
    expect(contexts.get(HTTP)!.stale[0]).toMatchObject({ owned: false, through: ['route.comments.store'] })
    expect(contexts.has(PAGES)).toBe(false)
  })

  test('should hold the step owning a child of a stale parent, which names nothing', () => {
    const contexts = judgeStepContext(PLAN, freshness([{ id: 'controller.posts', section: 'controllers', change: 'existing', verdict: 'stale', affects: [] }]), DERIVATION)

    const [owner] = [...contexts.values()]
    expect(owner!.stale).toEqual([expect.objectContaining({ id: 'controller.posts', owned: false, through: [], within: ['action.posts.feed'] })])
    expect(contexts.size).toBe(1)
  })

  test('should leave the marked step’s own stale elements out for every step, and keep what it only names', () => {
    const stale = freshness([
      { id: 'model.comment', change: 'add', verdict: 'stale', affects: ['route.comments.store'] },
      { id: 'policy.comment', section: 'policies', change: 'add', verdict: 'stale', affects: [] },
    ])

    expect(staleOf(judgeStepContext(PLAN, stale, DERIVATION, { inProgress: DATA }))).toEqual({ [HTTP]: ['policy.comment'] })
    expect(staleOf(judgeStepContext(PLAN, stale, DERIVATION))).toEqual({ [DATA]: ['model.comment'], [HTTP]: ['model.comment', 'policy.comment'] })
  })

  test('should never hold a step on an unstamped or unjudged element, reporting it as unconfirmed', () => {
    const contexts = judgeStepContext(
      PLAN,
      freshness([
        { id: 'model.post', verdict: 'unstamped', affects: ['route.comments.store'] },
        { id: 'validator.comment', section: 'validators', change: 'add', verdict: 'unjudged', affects: [] },
      ]),
      DERIVATION,
    )

    expect(staleOf(contexts)).toEqual({})
    expect(contexts.get(HTTP)!.unconfirmed.map((element) => [element.id, element.verdict])).toEqual([
      ['model.post', 'unstamped'],
      ['validator.comment', 'unjudged'],
    ])
  })

  test('should take the mark as the step in progress, stalled or not', () => {
    expect(stepInProgress(undefined)).toBeUndefined()
    expect(stepInProgress({ step: DATA })).toBe(DATA)
    expect(stepInProgress({ step: DATA, stalled: { at: 't', reason: 'r', output: 'o' } } as { step: string })).toBe(DATA)
  })
})
