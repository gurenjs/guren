import { describe, expect, test } from 'bun:test'
import type { DevCenterPlan } from '../src/dev-center-page/plans'
import { planAttention, sortPlans, stepsByTask } from '../src/dev-center-page/plans'
import { devCenterPlanLine, planPagePath, planSlugFromPath } from '../src/dev-center-links'

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

  test('should rank a draft\'s approval over records that would not read, and name those records otherwise', () => {
    const records = { unreadable: ['.guren/plans/comments.state.json would not read: bad JSON'] }
    expect(planAttention(plan({ standing: 'draft', ...records }))).toMatchObject({ title: 'Review and approve' })
    expect(planAttention(plan({ steps: [step('a', 'not-run')], ...records }))).toMatchObject({ who: 'person', title: 'Records would not read' })
  })

  test('should wait on a person when the Stop hook stalled a step', () => {
    const stalled = plan({ steps: [step('a', 'failed', { active: true, stall: { at: '2026-10-31T00:00:00Z', reason: 'Three continuations.' } })] })
    expect(planAttention(stalled)).toMatchObject({ who: 'person', title: 'Stalled on a' })
  })

  test('should wait on a person to close once every step is verified', () => {
    expect(planAttention(plan({ steps: [step('a', 'verified'), step('b', 'verified')] }))).toMatchObject({ who: 'person', title: 'Ready to close' })
  })

  test('should wait on a person for an approved plan that derives no steps, as plan:next hands out none', () => {
    expect(planAttention(plan({ steps: [] }))).toMatchObject({ who: 'person', title: 'Nothing to implement' })
  })

  test('should leave an approved plan in progress to the agent, naming the marked step', () => {
    const working = plan({ steps: [step('a', 'verified'), step('b', 'failed', { active: true }), step('c', 'not-run')] })
    expect(planAttention(working)).toEqual({ who: 'agent', title: 'In progress', detail: 'Marked by plan:next: b.' })
  })
})

test('sortPlans should put the plans waiting on a person first', () => {
  const working = plan({ file: 'a.plan.json', steps: [step('a', 'not-run')] })
  const draft = plan({ file: 'b.plan.json', standing: 'draft' })
  const sorted = sortPlans([working, draft])
  expect(sorted.map((entry) => entry.plan.file)).toEqual(['b.plan.json', 'a.plan.json'])
  expect(sorted.map((entry) => entry.attention.who)).toEqual(['person', 'agent'])
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

test('planPagePath should be the path planSlugFromPath reads back', () => {
  for (const slug of ['comments', 'a b', 'ünïcode']) expect(planSlugFromPath(planPagePath(slug))).toBe(slug)
  expect(devCenterPlanLine(planPagePath('comments'))).toContain('/_guren/plans/comments')
})
