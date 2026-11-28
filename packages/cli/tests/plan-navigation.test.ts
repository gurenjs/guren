import { describe, expect, test } from 'bun:test'

import type { PlanAppDetail } from '../src/plan/app-detail'
import { canonicalJson } from '../src/plan/identity'
import { planElementsWithoutBehaviour } from '../src/plan/reach'
import { createPlanRevision } from '../src/plan/revision'
import { PlanDraftSchema, planDraftJsonSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { derivePlanTasks } from '../src/plan/tasks'
import { validatePlan } from '../src/plan/validate'
import { loadCommentsPlan, planAppState } from './plan-fixture'

type Loose = Record<string, any>

const POSTS = { id: 'nav.posts', change: { kind: 'add' as const }, route: 'posts.index', label: 'Posts' }

/** The comments plan with an index page of its own: an action rendering it and the GET route to that action. */
function withIndex(navigation: Loose[] = []): Loose {
  const plan = structuredClone(loadCommentsPlan()) as Loose
  plan.planVersion = 2
  plan.controllers[0].actions.push({ id: 'action.comments.index', change: { kind: 'add' }, name: 'index', authorization: { middleware: [] }, response: { kind: 'inertia', view: 'view.comments.index' }, rules: [] })
  plan.routes.push({ id: 'route.comments.index', change: { kind: 'add' }, method: 'GET', path: '/comments', name: 'comments.index', action: 'action.comments.index', middleware: [], bind: [] })
  plan.views.push({ id: 'view.comments.index', change: { kind: 'add' }, page: 'comments/Index', purpose: 'List the comments.', props: [], actions: [], states: {} })
  if (navigation.length > 0) plan.navigation = navigation
  return plan
}

const parse = (plan: Loose) => PlanDraftSchema.parse(plan)

/** The findings the navigation section is responsible for, which the comments plan's own warnings would bury. */
const navigationFindings = (plan: Loose, app = planAppState()) =>
  validatePlan(parse(plan), app)
    .filter((result) => result.status !== 'pass' && (result.section === 'navigation' || result.key.startsWith('plan:navigation') || result.key.startsWith('plan:app-')))
    .map((result) => [result.key, result.status, result.message])

describe('the navigation section of a plan (RFC 0040 §5)', () => {
  test('should hold entries on a version 2 plan only, never renamed, and read an empty section as absent', () => {
    const refused = PlanDraftSchema.safeParse({ ...loadCommentsPlan(), navigation: [POSTS] })
    expect(refused.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([['navigation', 'needs planVersion 2']])
    expect(PlanDraftSchema.safeParse(withIndex([{ ...POSTS, change: { kind: 'rename', from: 'blog.index' } }])).success).toBe(false)
    expect(canonicalJson(parse({ ...withIndex(), navigation: [] }))).toBe(canonicalJson(parse(withIndex())))
    const schema = planDraftJsonSchema() as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toContain('navigation')
    expect(schema.required).not.toContain('navigation')
  })

  test('should take a route by the id of the plan\'s route or the name of the application\'s', () => {
    expect(navigationFindings(withIndex([{ id: 'nav.comments', change: { kind: 'add' }, route: 'route.comments.index', label: 'Comments' }]))).toEqual([])
    expect(navigationFindings(withIndex([POSTS]))).toEqual([])
    expect(navigationFindings(withIndex([{ ...POSTS, route: 'nope' }]))).toEqual([
      ['plan:navigation-route', 'fail', 'The entry links "nope", which is neither the id of a route in the plan nor the name of one the application registers.'],
    ])
  })

  test('should refuse a route that is no parameterless GET rendering a page, and an added entry with no label', () => {
    expect(navigationFindings(withIndex([{ id: 'nav.post', change: { kind: 'add' }, route: 'posts.show' }]))).toEqual([
      ['plan:navigation-entry', 'fail', 'The entry for "posts.show" is added with no label.'],
      ['plan:navigation-route', 'fail', 'The entry links "posts.show" (GET /posts/:id); an entry links a GET route with no path parameter.'],
    ])
    expect(navigationFindings(withIndex([{ id: 'nav.store', change: { kind: 'add' }, route: 'route.comments.store', label: 'Post' }]))).toEqual([
      ['plan:navigation-route', 'fail', 'The entry links "route.comments.store" (POST /posts/:postId/comments); an entry links a GET route with no path parameter.'],
      ['plan:navigation-route', 'fail', 'The entry links "route.comments.store", whose action does not render a page.'],
    ])
  })

  test('should hold a can to an ability its policy lists', () => {
    const entry = { id: 'nav.comments', change: { kind: 'add' }, route: 'route.comments.index', label: 'Comments' }
    expect(navigationFindings(withIndex([{ ...entry, can: { ability: 'delete', policy: 'policy.comment' } }]))).toEqual([])
    expect(navigationFindings(withIndex([{ ...entry, can: { ability: 'view', policy: 'policy.comment' } }]))).toEqual([
      ['plan:navigation-entry', 'fail', 'The entry for "route.comments.index" asks "view" of the policy "policy.comment", which lists no such ability.'],
    ])
    const dangling = validatePlan(parse(withIndex([{ ...entry, can: { ability: 'delete', policy: 'policy.nope' } }])), planAppState())
    expect(dangling.some((result) => result.status === 'fail' && result.elementId === 'nav.comments' && result.message.includes('policy.nope'))).toBe(true)
  })

  test('should judge an entry against config/navigation.ts by its route, and one route to one element', () => {
    expect(navigationFindings(withIndex([POSTS]), planAppState({ navigation: ['posts.index'] }))).toEqual([
      ['plan:app-collision', 'fail', 'The navigation entry for route "posts.index" already exists in the project root.'],
    ])
    expect(navigationFindings(withIndex([{ ...POSTS, change: { kind: 'alter' } }]))).toEqual([
      ['plan:app-missing', 'fail', 'The navigation entry for route "posts.index" was not found in the project root, and the plan\'s change is "alter".'],
    ])
    expect(navigationFindings(withIndex([POSTS, { ...POSTS, id: 'nav.posts.again' }])).map(([key]) => key)).toEqual(['plan:duplicate-entry'])
    // A navigation file the reader cannot read warns only a plan stating an entry.
    const unreadable = planAppState({ navigation: { unreadable: 'config/navigation.ts spreads its entries' } })
    expect(navigationFindings(withIndex(), unreadable)).toEqual([])
    expect(navigationFindings(withIndex([POSTS]), unreadable).map(([key, status]) => [key, status])).toEqual([['plan:app-unreadable', 'warn']])
  })

  test('should place an entry with the page its route renders, accepted at approval on its step alone', () => {
    const plan = parse(withIndex([{ id: 'nav.comments', change: { kind: 'add' }, route: 'route.comments.index', label: 'Comments' }, { ...POSTS, id: 'nav.posts' }]))
    const steps = derivePlanTasks(plan).tasks.flatMap((task) => task.steps)
    expect(steps.find((step) => step.elementIds.includes('nav.comments'))?.id).toBe('task/entity/model.comment/pages')
    expect(steps.find((step) => step.elementIds.includes('nav.posts'))?.id).toBe('task/foundation/pages')
    expect(planElementsWithoutBehaviour(plan).filter((element) => element.section === 'navigation')).toEqual([
      { id: 'nav.comments', section: 'navigation' },
      { id: 'nav.posts', section: 'navigation' },
    ])
  })

  test('should move a version 1 plan to version 2 when a revision adds the first entry', () => {
    const parent = parse(loadCommentsPlan())
    const revised = createPlanRevision(parent, { ops: [{ op: 'add', section: 'navigation', element: POSTS, reason: 'The layout links the posts.' }] })
    if (!revised.ok) throw new Error(JSON.stringify(revised.rejections))
    expect(revised.plan.planVersion).toBe(2)
    expect(revised.plan.navigation).toEqual([POSTS])
  })
})

describe('plan:status on a navigation entry', () => {
  const plan = PlanDraftSchema.parse({
    planVersion: 2,
    title: 'Posts',
    summary: 'Link the posts.',
    scope: { goals: [], nonGoals: [] },
    locale: 'en',
    models: [{ id: 'model.post', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [] }],
    policies: [{ id: 'policy.post', change: { kind: 'existing' }, name: 'PostPolicy', model: 'model.post', abilities: [{ name: 'viewAny', rule: 'Signed in.' }] }],
    navigation: [
      { ...POSTS, auth: 'required', can: { ability: 'viewAny', policy: 'policy.post' } },
      { id: 'nav.home', change: { kind: 'drop', reason: 'The brand links home.' }, route: 'home' },
    ],
  })
  const judge = (entries: PlanAppDetail['navigation'], names: string[]) =>
    judgePlan(plan, planAppState({ navigation: names, detail: { navigation: entries, unparsedModelFiles: [] } as unknown as PlanAppDetail }))
      .elements.filter((element) => element.section === 'navigation')
      .map((element) => [element.id, element.state, element.properties.map((property) => [property.property, property.verdict])])

  test('should match what the entry shows, and read a dropped entry as done once it is gone', () => {
    const entry = { label: 'Posts', route: 'posts.index', auth: 'required' as const, can: { ability: 'viewAny', model: { expression: 'Post', className: 'Post' } }, line: 7 }
    expect(judge([entry], ['posts.index'])).toEqual([
      ['nav.posts', 'present', [['label', 'match'], ['auth', 'match'], ['can', 'match']]],
      ['nav.home', 'present', []],
    ])
  })

  test('should tell an entry that shows something else, and a dropped one still there', () => {
    expect(judge([{ label: 'Blog', route: 'posts.index', line: 7 }, { label: 'Home', route: 'home', line: 8 }], ['home', 'posts.index'])).toEqual([
      ['nav.posts', 'drifted', [['label', 'differ'], ['auth', 'differ'], ['can', 'differ']]],
      ['nav.home', 'planned', []],
    ])
  })
})
