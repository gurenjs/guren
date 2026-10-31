import { describe, expect, test } from 'bun:test'
import type { DevCenterPlan } from '../src/dev-center-page/plans'
import { planAttention, planSlugFromPath, sortPlans, stepsByTask } from '../src/dev-center-page/plans'
import { devCenterPlanLine, devCenterPlanPath } from '../src/dev-center-links'

function plan(overrides: Partial<DevCenterPlan> = {}): DevCenterPlan {
  return { file: 'docs/plans/comments/plan.json', slug: 'comments', title: 'Comments', standing: 'approved', entities: [], steps: [], waivers: [], next: [], status: 'bunx guren plan:status docs/plans/comments/plan.json', ...overrides }
}
const step = (id: string, state: DevCenterPlan['steps'][number]['state'], extra: Partial<DevCenterPlan['steps'][number]> = {}) => ({ id, task: 'Comments', state, ...extra })

describe('planAttention', () => {
  test('should wait on a person for a draft, an edited plan and an unreadable one', () => {
    expect(planAttention(plan({ standing: 'draft' }))).toMatchObject({ who: 'person', title: 'Review and approve' })
    expect(planAttention(plan({ standing: 'unapproved' }))).toMatchObject({ who: 'person', title: 'Approve the edited plan' })
    expect(planAttention(plan({ standing: 'unreadable', reason: 'bad JSON' }))).toEqual({ who: 'person', title: 'Cannot be judged', detail: 'bad JSON' })
  })

  test('should wait on a person when the Stop hook stalled a step', () => {
    const stalled = plan({ steps: [step('a', 'failed', { active: true, stall: { at: '2026-10-31T00:00:00Z', reason: 'Three continuations.' } })] })
    expect(planAttention(stalled)).toMatchObject({ who: 'person', title: 'Stalled on a' })
  })

  test('should wait on a person to close once every step is verified', () => {
    expect(planAttention(plan({ steps: [step('a', 'verified'), step('b', 'verified')] }))).toMatchObject({ who: 'person', title: 'Ready to close' })
  })

  test('should leave an approved plan in progress to the agent, naming the marked step', () => {
    const working = plan({ steps: [step('a', 'verified'), step('b', 'failed', { active: true }), step('c', 'not-run')] })
    expect(planAttention(working)).toEqual({ who: 'agent', title: 'In progress', detail: 'Marked by plan:next: b.' })
  })
})

test('sortPlans should put the plans waiting on a person first', () => {
  const working = plan({ file: 'a.plan.json', steps: [step('a', 'not-run')] })
  const draft = plan({ file: 'b.plan.json', standing: 'draft' })
  expect(sortPlans([working, draft]).map((entry) => entry.file)).toEqual(['b.plan.json', 'a.plan.json'])
})

test('stepsByTask should group consecutive steps of one task', () => {
  const groups = stepsByTask(plan({ steps: [step('a', 'verified'), { ...step('b', 'not-run'), task: 'Moderation' }, { ...step('c', 'not-run'), task: 'Moderation' }] }))
  expect(groups.map((group) => [group.task, group.steps.length])).toEqual([['Comments', 1], ['Moderation', 2]])
})

test('planSlugFromPath should read one encoded segment and nothing deeper', () => {
  expect(planSlugFromPath('/_guren/plans/comments')).toBe('comments')
  expect(planSlugFromPath('/_guren/plans/a%20b')).toBe('a b')
  expect(planSlugFromPath('/_guren/plans/a/b')).toBeUndefined()
  expect(planSlugFromPath('/_guren')).toBeUndefined()
  expect(planSlugFromPath('/_guren/plans/%E0')).toBeUndefined()
})

test('devCenterPlanPath should name the slug of a plan.json and of a *.plan.json', () => {
  expect(devCenterPlanPath('docs/plans/comments/plan.json')).toBe('/_guren/plans/comments')
  expect(devCenterPlanPath('comments.plan.json')).toBe('/_guren/plans/comments')
  expect(devCenterPlanLine('docs/plans/comments/plan.json')).toContain('/_guren/plans/comments')
})
