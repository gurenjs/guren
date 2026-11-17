import { describe, expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consola } from 'consola'
import type { z } from 'zod'

import { addBrowserTests, agentConfig } from '../src/add-browser-tests'
import {
  BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP, buildBehaviourSpecs, configNamesAgent, GENERATED_BEHAVIOURS_DIR,
} from '../src/browser-behaviour-specs'
import { isParameterless, type ApprovedPlanInput, type BrowserFeature, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from '../src/browser-map'
import { runBrowserMap } from '../src/browser-map-files'
import { BROWSER_TESTS_CONFIG, GENERATED_HEADER } from '../src/browser-specs'
import { PlanDraftSchema, type Plan, type PlanAcceptance } from '../src/plan/schema'
import { PLAN_VERSION } from '../src/plan/version'
import { checkTypes, createTempWorkspace, seedInertiaApp, templateCompilerOptions, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'

const transpiler = new Bun.Transpiler({ loader: 'ts' })
const CLI_ROOT = join(import.meta.dir, '..')
const TEMPLATE_ROOT = join(CLI_ROOT, 'templates/scaffold/browser-tests')
const FILE = 'docs/plans/posts/plan.json'
const SPEC = `${GENERATED_BEHAVIOURS_DIR}/posts.e2e.ts`
const existing = { kind: 'existing' } as const

type PlanInput = z.input<typeof PlanDraftSchema>
type ViewInput = NonNullable<PlanInput['views']>[number]

function planRoute(name: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'QUERY', path: string) {
  return { id: `route.posts.${name}`, change: existing, method, path, name: `posts.${name}`, action: `action.post.${name}`, middleware: [], bind: [] }
}

const titleField = { field: 'title', label: 'Title', input: 'text' } as const

const VIEWS: ViewInput[] = [
  { id: 'view.posts.index', change: existing, page: 'posts/Index', purpose: 'Lists the posts.', props: [], actions: [{ label: 'New Post', route: 'route.posts.create' }], states: {} },
  {
    id: 'view.posts.new', change: existing, page: 'posts/New', purpose: 'Writes a post.', props: [],
    form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [titleField, { field: 'authorId', label: 'Author', input: 'hidden' }] },
    actions: [{ label: 'Create', route: 'route.posts.store' }], states: {},
  },
  {
    id: 'view.posts.show', change: existing, page: 'posts/Show', purpose: 'Shows a post.', props: [],
    actions: [{ label: 'Edit', route: 'route.posts.edit' }, { label: 'Delete', route: 'route.posts.destroy' }], states: {},
  },
  {
    id: 'view.posts.edit', change: existing, page: 'posts/Edit', purpose: 'Edits a post.', props: [],
    form: { validator: 'validator.post', submitsTo: 'route.posts.update', fields: [titleField] }, actions: [], states: {},
  },
]

function behaviour(id: string, route: string, overrides: Partial<PlanAcceptance> = {}): PlanAcceptance {
  return { id, description: `does ${id}`, kind: 'success', actor: 'a signed-in user', route: `route.posts.${route}`, given: [], expect: {}, ...overrides }
}

const input = (values: Record<string, unknown>): PlanAcceptance['input'] => Object.entries(values).map(([name, value]) => ({ name, json: JSON.stringify(value) }))

function planOf(acceptance: PlanAcceptance[], views: ViewInput[] = VIEWS): Plan {
  const draft: PlanInput = {
    planVersion: PLAN_VERSION, title: 'Posts', summary: 'The posts pages.', scope: { goals: [], nonGoals: [] }, locale: 'en',
    validators: [{ id: 'validator.post', change: existing, name: 'PostPayloadSchema', fields: [
      { name: 'title', type: 'string', required: true, rules: ['max 12'] },
      { name: 'body', type: 'text', required: false, rules: [] },
      { name: 'rating', type: 'integer', required: false, rules: ['min 1', 'max 5'] },
      { name: 'email', type: 'string', required: false, rules: ['email'] },
      { name: 'publishedOn', type: 'date', required: false, rules: [] },
    ] }],
    routes: [
      planRoute('index', 'GET', '/posts'), planRoute('create', 'GET', '/posts/create'), planRoute('store', 'POST', '/posts'),
      planRoute('show', 'GET', '/posts/:id'), planRoute('edit', 'GET', '/posts/:id/edit'), planRoute('update', 'PUT', '/posts/:id'),
      planRoute('destroy', 'DELETE', '/posts/:id'), planRoute('search', 'QUERY', '/posts/search'),
    ],
    views,
    tasks: [{ id: 'task.posts', entity: 'Post', summary: 'The posts pages.', covers: [], acceptance }],
  }
  return PlanDraftSchema.parse(draft) as unknown as Plan
}

function route(method: string, path: string, name: string, pages: string[] = [], authentication?: BrowserMapRoute['authentication']): BrowserMapRoute {
  return { method, path, name, middleware: [], pages, ...(authentication ? { authentication } : {}) }
}

const ROUTES = {
  index: route('GET', '/posts', 'posts.index', ['posts/Index']),
  create: route('GET', '/posts/create', 'posts.create', ['posts/New']),
  store: route('POST', '/posts', 'posts.store'),
  show: route('GET', '/posts/:id', 'posts.show', ['posts/Show']),
  edit: route('GET', '/posts/:id/edit', 'posts.edit', ['posts/Edit']),
  update: route('PUT', '/posts/:id', 'posts.update'),
  destroy: route('DELETE', '/posts/:id', 'posts.destroy'),
}

function mapOf(plan: Plan, routes: BrowserMapRoute[] = Object.values(ROUTES), overrides: Partial<BrowserMap> = {}): BrowserMap {
  const views: BrowserMapView[] = plan.views.map((view) => ({ plan: FILE, view, routes: routes.filter((entry) => entry.method === 'GET' && entry.pages.includes(view.page)) }))
  const landmark = routes.find((entry) => entry.method === 'GET' && entry.pages.length > 0 && isParameterless(entry.path))
  const posts: BrowserFeature = {
    name: 'posts', file: 'docs/browser/posts.md', pages: [...new Set(routes.flatMap((entry) => entry.pages))], routes,
    ...(landmark ? { landmark } : {}), entities: [], acceptance: [], views,
  }
  return { complete: true, gaps: [], features: [posts], unreached: [], unassigned: [], unresolvedRenders: [], unplaced: [], unplacedViews: [], plans: [FILE], unreadablePlans: [], ...overrides }
}

const withView = (id: string, change: Partial<ViewInput>): ViewInput[] => VIEWS.map((view) => view.id === id ? { ...view, ...change } : view)
const withRoute = (from: BrowserMapRoute, to: Partial<BrowserMapRoute>): BrowserMapRoute[] => Object.values(ROUTES).map((entry) => entry === from ? { ...entry, ...to } : entry)

function generate(acceptance: PlanAcceptance[], options: { signIn?: boolean; agent?: boolean; routes?: BrowserMapRoute[]; map?: Partial<BrowserMap>; views?: ViewInput[] } = {}) {
  const plan = planOf(acceptance, options.views)
  const plans: ApprovedPlanInput[] = [{ file: FILE, plan }]
  return buildBehaviourSpecs(mapOf(plan, options.routes, options.map), plans, { signIn: options.signIn ?? true, agent: options.agent ?? true }, new Map())
}

const contentsOf = (acceptance: PlanAcceptance[], options?: Parameters<typeof generate>[1]): string => generate(acceptance, options).files[0]!.contents

const STORE = behaviour('AC-posts-store-1', 'store', { description: 'a signed-in user creates a post', input: input({ title: 'First' }), expect: { redirect: '/posts/:id', inertia: 'view.posts.show' } })

describe('the behaviour specs', () => {
  test('write one test per behaviour a view sends: the start page, locator steps where the plan names every control, then locator pins', () => {
    const { files, unlabelled } = generate([STORE])
    expect(files.map((entry) => entry.path)).toEqual([SPEC])
    const contents = files[0]!.contents
    expect(contents.startsWith(GENERATED_HEADER)).toBe(true)
    expect(contents).toMatch(/test\('AC-posts-store-1 \([0-9a-f]{6}\): a signed-in user creates a post', \{ session: 'browser' \}, async \(\{ app, screen, browser \}\) => \{/u)
    expect(contents).toContain("const start = await begin('AC-posts-store-1', undefined, { app, browser })")
    expect(contents).toContain("await app.open('/posts/create')")
    expect(contents).toContain("await screen.getByLabel('Title', { exact: true }).fill('First')")
    expect(contents).toContain("await screen.getByRole('button', 'Create').or(screen.getByRole('link', 'Create')).tap()")
    expect(contents).not.toContain('agent.act')
    expect(contents).toContain("await expect(browser).toHaveURL(landed(['/posts/', { not: ['create'] }], start))")
    expect(contents).toContain("await expect(screen.getByRole('button', 'Edit').or(screen.getByRole('link', 'Edit')).first()).toBeVisible()")
    expect(contents).not.toContain('agent.assert')
    expect(contents).not.toMatch(/\[AC-/u)
    expect(unlabelled).toEqual([])
    expect(() => transpiler.transformSync(contents)).not.toThrow()
  })

  test('accept a dialog for the length of the step, after the locale check', () => {
    const body = contentsOf([STORE]).split("test('AC-posts-store-1")[1]!
    const update = contentsOf([behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:id' } })]).split("test('AC-posts-update-1")[1]!
    for (const [text, step] of [[body, '.fill('], [body, '.tap()'], [update, 'await agent.act(']] as const) {
      const order = ['await expectDefaultLocale(browser)', "const off = await browser.onDialog('accept')", step, 'await off()', 'await expect(browser)']
      const positions = order.map((line) => text.indexOf(line))
      expect(positions.every((position) => position > 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
  })

  test('pin a validation error on the labelled control, and leave a status unpinned', () => {
    const contents = contentsOf([behaviour('AC-posts-store-2', 'store', { kind: 'validation', input: input({ title: '   ' }), expect: { status: 422, errors: ['title', 'authorId'] } })])
    expect(contents).toContain("await expect(screen.getByLabel('Title', { exact: true }).first()).toHaveAttribute('aria-invalid', 'true')")
    expect(contents).not.toContain("getByLabel('Author'")
    expect(contents).not.toContain('status')
  })

  test('fill a path parameter of the start page from given.ts, and reuse its value in the redirect', () => {
    const contents = contentsOf([behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:id' } })])
    expect(contents).toContain("const start = await begin('AC-posts-update-1', 'its start page /posts/:id/edit takes a path parameter', { app, browser })")
    expect(contents).toContain("await app.open(`/posts/${start.value('id')}/edit`)")
    // The edit view names no action for the route, so the step ends "submit the form" and is the agent's.
    expect(contents).toContain(`await agent.act('set "Title" to {title}, then submit the form', { params: { title: 'Again' } })`)
    expect(contents).toMatch(/async \(\{ app, agent, browser \}\)/u)
    expect(contents).toContain("await expect(browser).toHaveURL(landed(['/posts/', { known: 'id' }], start))")
  })

  test('lex a path as the route generators do: a dash in a name, a constraint, and no optional or wildcard start page', () => {
    const update = behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:post-id{[0-9]+}' } })
    const contents = contentsOf([update], { routes: withRoute(ROUTES.edit, { path: '/posts/:post-id{[0-9]+}/edit' }) })
    expect(contents).toContain("await app.open(`/posts/${start.value('post-id')}/edit`)")
    expect(contents).toContain("landed(['/posts/', { known: 'post-id' }], start)")
    expect(contentsOf([update], { routes: withRoute(ROUTES.edit, { path: '/posts/:id?/edit' }) })).toContain('has an optional or wildcard segment, which given.ts cannot fill')
    expect(() => transpiler.transformSync(contents)).not.toThrow()
  })

  test('ask given.ts for a behaviour the plan gives a starting state, and start an action view with no input', () => {
    const contents = contentsOf([behaviour('AC-posts-destroy-1', 'destroy', { given: ['a post exists'], expect: { redirect: '/posts' } })], { routes: Object.values(ROUTES).filter((entry) => entry !== ROUTES.show).concat(route('GET', '/posts/latest', 'posts.latest', ['posts/Show'])) })
    expect(contents).toContain("  await begin('AC-posts-destroy-1', 'the plan gives it a starting state', { app, browser })")
    expect(contents).not.toContain('const start =')
    expect(contents).toContain("await app.open('/posts/latest')")
    expect(contents).toContain("await screen.getByRole('button', 'Delete').or(screen.getByRole('link', 'Delete')).tap()")
    expect(contents).toContain("await expect(browser).toHaveURL('/posts')")
  })

  test('fill a text field, set a checkbox and pick a select option by value, and leave a date or file control to the agent', () => {
    const fields = [titleField, { field: 'featured', label: 'Featured', input: 'checkbox' }, { field: 'category', label: 'Category', input: 'select' }] as const
    const views = withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [...fields] } })
    const contents = contentsOf([{ ...STORE, input: input({ title: 'First', featured: false, category: 3 }) }], { views })
    expect(contents).toContain("await screen.getByLabel('Featured', { exact: true }).uncheck()")
    expect(contents).toContain("await screen.getByLabel('Category', { exact: true }).selectOption({ value: '3' })")
    expect(contents).not.toContain('agent.act')
    for (const control of ['date', 'datetime', 'file'] as const) {
      const dated = withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [titleField, { field: 'publishedOn', label: 'Published on', input: control }] } })
      const agentStep = contentsOf([{ ...STORE, input: input({ title: 'First', publishedOn: '2026-11-15' }) }], { views: dated })
      expect(agentStep).toContain(`await agent.act('set "Title" to {title}, set "Published on" to {publishedOn}, then use "Create"'`)
      expect(agentStep).not.toContain('.fill(')
    }
    const checkedText = contentsOf([{ ...STORE, input: input({ title: 'First', featured: 'yes' }) }], { views })
    expect(checkedText).toContain('agent.act')
  })

  test('fill a number or textarea control only with what it keeps as written, and leave a doubly labelled or hidden key to the agent', () => {
    const form = (fields: ReadonlyArray<{ field: string; label: string; input: 'text' | 'textarea' | 'number' | 'hidden' }>) =>
      withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [...fields] } })
    const store = (values: Record<string, unknown>, views: ViewInput[]) => contentsOf([{ ...STORE, input: input(values) }], { views })
    const rated = form([titleField, { field: 'rating', label: 'Rating', input: 'number' }, { field: 'body', label: 'Body', input: 'textarea' }])
    const filled = store({ title: 'First', rating: 4, body: 'One\nTwo' }, rated)
    expect(filled).toContain("await screen.getByLabel('Rating', { exact: true }).fill('4')")
    expect(filled).toContain("await screen.getByLabel('Body', { exact: true }).fill('One\\nTwo')")
    expect(filled).not.toContain('agent.act')
    expect(store({ title: 'First', rating: '4.5' }, rated)).toContain(".fill('4.5')")
    for (const [values, views] of [
      [{ title: 'First', rating: 'four' }, rated],
      [{ title: 'First', rating: '1e3' }, rated],
      [{ title: 'One\nTwo' }, rated],
      [{ title: 'First' }, form([titleField, { field: 'title', label: 'Final title', input: 'text' }])],
      [{ title: 'First' }, form([{ field: 'title', label: 'Title', input: 'hidden' }])],
    ] as const) {
      const contents = store(values, views)
      expect(contents).toContain('await agent.act(')
      expect(contents).not.toContain('.fill(')
    }
  })

  test('skip a behaviour that needs an agent step when the config names no agent, and still write the located ones', () => {
    const update = behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:id' } })
    const contents = contentsOf([STORE, update], { agent: false })
    expect(contents).toContain("await screen.getByRole('button', 'Create').or(screen.getByRole('link', 'Create')).tap()")
    expect(contents).toContain("test.skip('AC-posts-update-1: does AC-posts-update-1: needs an agent step, since the plan does not name every control it touches, and the config names no agent (e2e.browser.config.ts imports no executor from @e2e-dev/acp, or the app does not declare it)'")
    expect(contents).not.toContain('agent.act')
    expect(() => transpiler.transformSync(contents)).not.toThrow()
  })

  test('run signed in whenever the app can sign in, and signed out on a guest-only route', () => {
    expect(contentsOf([STORE], { signIn: true })).toContain("{ session: 'browser' }")
    expect(contentsOf([STORE], { signIn: false })).not.toContain('session:')
    expect(contentsOf([STORE], { signIn: true, routes: withRoute(ROUTES.store, { authentication: 'guest-only' }) })).not.toContain('session:')
  })

  test('name an input the form does not label, and report it', () => {
    const { files, unlabelled } = generate([{ ...STORE, input: input({ title: 'First', 'meta.tag': 'x' }) }])
    expect(files[0]!.contents).toContain(`'set "Title" to {title}, set the field for meta.tag to {input2}, then use "Create"', { params: { title: 'First', input2: 'x' } }`)
    expect(unlabelled).toEqual([`${FILE}: AC-posts-store-1: meta.tag`])
  })

  test('read labels and error pins from the view\'s form only when that form submits to the route', () => {
    const views = withView('view.posts.show', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [titleField] } })
    const destroy = behaviour('AC-posts-destroy-1', 'destroy', { kind: 'validation', input: input({ title: 'x' }), expect: { redirect: '/posts', errors: ['title'] } })
    const { files, unlabelled } = generate([destroy], { views })
    expect(files[0]!.contents).toContain(`await agent.act('set the field for title to {title}, then use "Delete"', { params: { title: 'x' } })`)
    expect(files[0]!.contents).not.toContain('aria-invalid')
    expect(unlabelled).toEqual([`${FILE}: AC-posts-destroy-1: title`])
  })

  test('leave out a pin that held before the step', () => {
    const contents = contentsOf([{ ...STORE, expect: { redirect: '/posts/create', inertia: 'view.posts.new', errors: ['title'] }, kind: 'validation', input: input({ title: '   ' }) }])
    expect(contents).not.toContain('toHaveURL')
    expect(contents).not.toContain('toBeVisible')
    expect(contents).toContain("toHaveAttribute('aria-invalid', 'true')")
    expect(contentsOf([{ ...STORE, expect: { redirect: '/posts/:id?' , inertia: 'view.posts.show' } }])).not.toContain('toHaveURL')
  })

  test('leave out a label or an action the sending view shows too, whatever view the plan lands on', () => {
    const update = behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { inertia: 'view.posts.new' } })
    const contents = contentsOf([update])
    expect(contents).not.toContain("await expect(screen.getByLabel('Title'")
    expect(contents).toContain("await expect(screen.getByRole('button', 'Create').or(screen.getByRole('link', 'Create')).first()).toBeVisible()")
  })

  test('give a changed test another title, and keep brackets out of it', () => {
    const digest = (contents: string): string => /AC-posts-store-1 \(([0-9a-f]{6})\)/u.exec(contents)![1]!
    const first = contentsOf([STORE])
    expect(digest(contentsOf([STORE]))).toBe(digest(first))
    expect(digest(contentsOf([{ ...STORE, input: input({ title: 'Second' }) }]))).not.toBe(digest(first))
    expect(digest(contentsOf([STORE], { signIn: false }))).not.toBe(digest(first))
    expect(contentsOf([{ ...STORE, description: 'creates a post [AC-other-1]' }])).toContain('): creates a post AC-other-1')
  })

  test('write the URL helper so a browser still on a sibling route does not satisfy a redirect', () => {
    const contents = contentsOf([STORE])
    const source = contents.slice(contents.indexOf('function landed('), contents.indexOf('/** The page rendered in'))
    type Part = string | { known: string } | { not: readonly string[] }
    // The generator's own output, evaluated to check the pattern it builds.
    const landed = new Function(`${transpiler.transformSync(source)}; return landed`)() as (parts: readonly Part[], start: { value(name: string): string }) => RegExp
    const start = { value: (name: string): string => ({ id: '7' } as Record<string, string>)[name]! }
    const pattern = landed(['/posts/', { not: ['create'] }], start)
    expect(pattern.test('http://127.0.0.1:4319/posts/12')).toBe(true)
    expect(pattern.test('/posts/12?saved=1')).toBe(true)
    expect(pattern.test('http://127.0.0.1:4319/posts/create')).toBe(false)
    expect(pattern.test('http://127.0.0.1:4319/posts/created')).toBe(true)
    expect(pattern.test('http://127.0.0.1:4319/posts/12/edit')).toBe(false)
    expect(landed(['/posts/', { known: 'id' }], start).test('http://127.0.0.1:4319/posts/8')).toBe(false)
    expect(landed(['/posts/', { known: 'id' }], start).test('http://127.0.0.1:4319/posts/7')).toBe(true)
    expect(landed(['/a.b/', { not: [] }], start).test('/aXb/1')).toBe(false)
  })
})

describe('a behaviour the spec cannot write is skipped, naming why', () => {
  const skipped = (acceptance: PlanAcceptance, options?: Parameters<typeof generate>[1]): string => {
    const contents = contentsOf([acceptance], options)
    expect(contents).toBe(`${GENERATED_HEADER}import { test } from '@e2e-dev/web'\n\n${contents.slice(contents.indexOf('test.skip('))}`)
    expect(() => transpiler.transformSync(contents)).not.toThrow()
    return /test\.skip\('(.*)', async \(\) => \{\}\)\n$/u.exec(contents)![1]!
  }

  test('a kind TestApp pins', () => {
    for (const kind of ['unauthenticated', 'forbidden', 'not-found', 'state'] as const) {
      expect(skipped({ ...STORE, kind })).toBe('AC-posts-store-1: a signed-in user creates a post: needs a second actor, a missing record or a state the plan words in prose; TestApp pins it')
    }
  })

  test('a GET or QUERY route', () => {
    expect(skipped(behaviour('AC-posts-index-1', 'index', { expect: { inertia: 'view.posts.index' } }))).toContain('its route is a GET')
    const views = withView('view.posts.index', { actions: [{ label: 'Search', route: 'route.posts.search' }] })
    expect(skipped(behaviour('AC-posts-search-1', 'search', { expect: { inertia: 'view.posts.show' } }), { views })).toContain('its route is a QUERY')
  })

  test('a route no view of the plan sends', () => {
    expect(skipped(STORE, { views: VIEWS.filter((view) => view.id !== 'view.posts.new') })).toContain('no view of the plan sends its route')
  })

  test('a route, or a start page, the app does not register yet', () => {
    expect(skipped(STORE, { routes: Object.values(ROUTES).filter((entry) => entry !== ROUTES.store) })).toContain('POST /posts (posts.store) is not registered yet')
    expect(skipped(STORE, { map: { unplaced: [{ plan: FILE, id: 'AC-posts-store-1', route: 'POST /posts (posts.store)' }] } })).toContain('is not registered yet')
    const unassigned = [{ method: 'POST', path: '/posts', name: 'posts.store', reason: 'Its action renders nothing, and neither does its controller.', candidates: [] }]
    expect(skipped(STORE, { routes: Object.values(ROUTES).filter((entry) => entry !== ROUTES.store), map: { unassigned } }))
      .toContain('the map places POST /posts (posts.store) in no feature: Its action renders nothing, and neither does its controller.')
    expect(skipped(STORE, { routes: Object.values(ROUTES).filter((entry) => entry !== ROUTES.create) })).toContain('no GET route renders posts/New yet')
  })

  test('a signed-in route in an app with no password sign-in', () => {
    expect(skipped(STORE, { signIn: false, routes: withRoute(ROUTES.store, { authentication: 'required' }) })).toContain('needs a signed-in user')
  })

  test('an input no control is known to take', () => {
    expect(skipped({ ...STORE, input: input({ title: 'First', tags: ['a'] }) })).toContain('an input is not a string, a number or a boolean')
  })

  test('a validation input the form\'s own control may stop', () => {
    const fields = [
      titleField, { field: 'rating', label: 'Rating', input: 'number' }, { field: 'email', label: 'Email', input: 'text' },
      { field: 'publishedOn', label: 'Published on', input: 'date' },
    ] as const
    const views = withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [...fields] } })
    const validation = behaviour('AC-posts-store-3', 'store', { kind: 'validation', expect: { errors: ['title'] } })
    const stopped = [
      { title: '' }, { title: null }, { body: 'x' }, { title: 'Hi', rating: 0 }, { title: 'Hi', rating: 1.5 }, { title: 'Hi', rating: '3' },
      { title: 'Hi', email: 'nope' }, { title: 'Hi', email: 'a@b..test' }, { title: 'Hi', publishedOn: '2025-02-30' }, { title: 'Hi', publishedOn: 'soon' },
      { title: 'a title past twelve' },
    ]
    for (const values of stopped) {
      expect(skipped({ ...validation, input: input(values) }, { views })).toContain('its input is one a control of the form may stop or change')
    }
    const written = contentsOf([{ ...validation, input: input({ title: '   ', rating: 3, email: 'a@b.test', publishedOn: '2025-02-28' }) }], { views })
    expect(written).toContain("toHaveAttribute('aria-invalid', 'true')")
  })

  test('an outcome no browser can check', () => {
    expect(skipped({ ...STORE, expect: { status: 302, database: [{ table: 'posts', has: [{ name: 'title', json: '"First"' }] }] } })).toContain('no outcome a browser can check')
    expect(skipped({ ...STORE, kind: 'validation', input: input({ title: '   ' }), expect: { errors: ['authorId'] } })).toContain('no outcome a browser can check')
    expect(skipped({ ...STORE, expect: { redirect: '/posts/create', inertia: 'view.posts.new' } })).toContain('already showed before the step')
  })

  test('a redirect the start page satisfies under another parameter name or constraint', () => {
    for (const redirect of ['/posts/:post', '/posts/:id{[0-9]+}']) {
      expect(skipped(behaviour('AC-posts-destroy-1', 'destroy', { expect: { redirect } }))).toContain('already showed before the step')
    }
  })

  test('a view that lands on nothing the sending view does not show', () => {
    const views = withView('view.posts.new', { actions: [] })
    expect(skipped(behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { inertia: 'view.posts.new' } }), { views })).toContain('already showed before the step')
  })
})

describe('the spec files', () => {
  test('one per plan with a behaviour, none for a plan with none, and a shared slug refuses', () => {
    expect(generate([]).files).toEqual([])
    const plan = planOf([STORE])
    expect(() => buildBehaviourSpecs(mapOf(plan), [{ file: FILE, plan }], { signIn: true, agent: true }, new Map([['posts', [FILE, 'posts.plan.json']]]))).toThrow('share the slug posts')
  })

  test('browser:map writes them on its four conditions, whatever the Playwright config, and removes them when one goes', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-behaviours-')
    try {
      const stale = `${GENERATED_BEHAVIOURS_DIR}/gone.e2e.ts`
      const declared = '{ "name": "app", "devDependencies": { "e2e": "0.23.1", "@e2e-dev/web": "0.16.0" } }\n'
      const plan = planOf([STORE])
      const run = (): ReturnType<typeof runBrowserMap> => runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf(plan), plans: [{ file: FILE, plan }] })

      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app", "devDependencies": { "e2e": "0.23.1" } }\n', [`${GENERATED_BEHAVIOURS_DIR}/mine.e2e.ts`]: '// mine\n' })
      const never = await run()
      expect(never.behavioursOff).toBeUndefined()
      expect(never.unlabelledInputs).toBeUndefined()
      expect(never.changed.filter((file) => file.startsWith('tests/'))).toEqual([])

      await writeWorkspaceFiles(workspace.dir, { 'package.json': declared, [stale]: `${GENERATED_HEADER}\n` })
      const noFiles = await run()
      expect(noFiles.behavioursOff).toBe(`${BEHAVIOURS_CONFIG} and ${BEHAVIOURS_GIVEN_FILE} do not exist`)
      expect(noFiles.removed).toEqual([stale])
      expect(await Bun.file(join(workspace.dir, stale)).exists()).toBe(false)

      await writeWorkspaceFiles(workspace.dir, { [BEHAVIOURS_CONFIG]: '// config\n' })
      expect((await run()).behavioursOff).toBe(`${BEHAVIOURS_GIVEN_FILE} does not exist`)

      await writeWorkspaceFiles(workspace.dir, { [BEHAVIOURS_GIVEN_FILE]: '// given\n', [stale]: `${GENERATED_HEADER}\n`, [`${GENERATED_BEHAVIOURS_DIR}/mine.e2e.ts`]: '// mine\n' })
      const on = await run()
      expect(on.behavioursOff).toBeUndefined()
      expect(on.changed).toContain(SPEC)
      expect(on.changed).not.toContain('tests/browser/generated/smoke.browser.ts')
      expect(on.removed).toEqual([stale])
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toBe(contentsOf([STORE], { signIn: false }))
      expect(await readFile(join(workspace.dir, `${GENERATED_BEHAVIOURS_DIR}/mine.e2e.ts`), 'utf8')).toBe('// mine\n')

      await writeWorkspaceFiles(workspace.dir, { [BEHAVIOURS_SETUP]: '// setup\n', [BROWSER_TESTS_CONFIG]: '// config\n' })
      const signedIn = await run()
      expect(signedIn.changed).toContain(SPEC)
      expect(signedIn.changed).toContain('tests/browser/generated/smoke.browser.ts')
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toBe(contentsOf([STORE], { signIn: true }))

      const otherPlans = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf(plan), plans: [] })
      expect(otherPlans.specsHeld).toBeDefined()
      expect(otherPlans.removed).toEqual([])
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toBe(contentsOf([STORE], { signIn: true }))

      await writeWorkspaceFiles(workspace.dir, { [SPEC]: '// mine\n' })
      await expect(run()).rejects.toThrow(`${SPEC}: it has no generated header, so it is yours; move it out of ${GENERATED_BEHAVIOURS_DIR}/`)
      await writeWorkspaceFiles(workspace.dir, { [SPEC]: `${GENERATED_HEADER}\n` })

      const partial = await runBrowserMap({ cwd: workspace.dir, write: true, map: { ...mapOf(plan), unreadablePlans: [{ plan: FILE, reason: 'it does not parse' }] }, plans: [{ file: FILE, plan }] })
      expect(partial.specsHeld).toBeDefined()
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toBe(`${GENERATED_HEADER}\n`)

      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app", "devDependencies": { "@e2e-dev/web": "0.16.0" } }\n' })
      const oneMissing = await run()
      expect(oneMissing.behavioursOff).toBe('e2e is not in package.json')
      expect(oneMissing.removed).toEqual([SPEC])
    } finally {
      await workspace.cleanup()
    }
  })

  test('typechecks against the runner beside the config, the setup and the given.ts the blueprint writes', async () => {
    const workspace = await createTempWorkspace('guren-behaviour-spec-types-')
    try {
      const fields = [titleField, { field: 'featured', label: 'Featured', input: 'checkbox' }, { field: 'category', label: 'Category', input: 'select' }] as const
      const views = withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [...fields] } })
      const contents = contentsOf([
        { ...STORE, input: input({ title: 'First', featured: true, category: 'news' }) },
        behaviour('AC-posts-store-2', 'store', { kind: 'validation', input: input({ title: '   ' }), expect: { errors: ['title'] } }),
        behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:id' } }),
      ], { views })
      for (const written of ['landed([', "toHaveAttribute('aria-invalid'", "begin('AC-posts-update-1'", '.fill(', '.check()', '.selectOption({ value:', '.tap()', 'agent.act(']) expect(contents).toContain(written)
      const files: Record<string, string> = { [SPEC]: contents }
      for (const file of [BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP]) files[file] = await readFile(join(TEMPLATE_ROOT, file), 'utf8')
      // The config as --agent codex writes it; only the Claude Code one is a file the template check reads.
      files['e2e.codex.config.ts'] = agentConfig({ path: BEHAVIOURS_CONFIG, contents: files[BEHAVIOURS_CONFIG]! }, 'codex').contents
      files['e2e.none.config.ts'] = agentConfig({ path: BEHAVIOURS_CONFIG, contents: files[BEHAVIOURS_CONFIG]! }, 'none').contents
      await writeWorkspaceFiles(workspace.dir, files)
      // The packages declare their types through `exports`, which a `paths` entry naming the directory does not read.
      const runner = Object.fromEntries(['e2e', '@e2e-dev/web', '@e2e-dev/acp'].map((name) => [name, [join(CLI_ROOT, 'node_modules', name, 'dist/index.d.ts')]]))
      const diagnostics = checkTypes(Object.keys(files).map((file) => join(workspace.dir, file)), { ...templateCompilerOptions(runner), types: ['bun-types', 'node'] })
      expect(diagnostics).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  }, TSC_TIMEOUT)

  test('add browser-tests --behaviours writes the spec its dry run announced, once the app declares the runner', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-spec-')
    try {
      const plan = planOf([STORE])
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': '{ "name": "app", "dependencies": { "@guren/inertia-client": "*" }, "devDependencies": { "e2e": "0.23.1", "@e2e-dev/web": "0.16.0" } }\n',
      })
      const result = await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf(plan), plans: [{ file: FILE, plan }] })
      expect(result.mapped.held).toBeUndefined()
      expect(result.mapped.behavioursOff).toBeUndefined()
      expect(result.mapped.changed).toContain(SPEC)
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toBe(contentsOf([STORE], { signIn: false }))

      // A spec of the author's at that path refuses in the dry run, before the blueprint's own files are written.
      await writeWorkspaceFiles(workspace.dir, { [SPEC]: '// mine\n', [BEHAVIOURS_CONFIG]: '// edited\n' })
      await expect(addBrowserTests({ install: false, force: true, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf(plan), plans: [{ file: FILE, plan }] })).rejects.toThrow('it has no generated header')
      expect(await readFile(join(workspace.dir, BEHAVIOURS_CONFIG), 'utf8')).toBe('// edited\n')
    } finally {
      await workspace.cleanup()
    }
  })

  test('switching an app set up for an agent to --agent none --force skips the agent steps and names the packages to remove', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-to-none-')
    const info = spyOn(consola, 'info').mockImplementation((() => {}) as never)
    try {
      const update = behaviour('AC-posts-update-1', 'update', { input: input({ title: 'Again' }), expect: { redirect: '/posts/:id' } })
      const plan = planOf([STORE, update])
      const plans = [{ file: FILE, plan }]
      await seedInertiaApp(workspace.dir)
      // The manifest as `--agent claude-code` leaves it once installed.
      const manifest = '{ "name": "app", "dependencies": { "@guren/inertia-client": "*" }, "devDependencies": { "e2e": "0.23.1", "@e2e-dev/web": "0.16.0", "@e2e-dev/acp": "0.5.0", "@agentclientprotocol/claude-agent-acp": "^0.107.0" } }\n'
      await writeWorkspaceFiles(workspace.dir, { 'package.json': manifest })
      const run = (agent: string) => addBrowserTests({ install: false, force: true, behaviours: true, agent, loadMap: async () => mapOf(plan), plans })

      await run('claude-code')
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toContain('await agent.act(')
      await writeWorkspaceFiles(workspace.dir, { [BEHAVIOURS_GIVEN_FILE]: '// mine\n', '.e2e/cache/recorded.json': '{}\n' })

      info.mockClear()
      const none = await run('none')
      const config = await readFile(join(workspace.dir, BEHAVIOURS_CONFIG), 'utf8')
      expect(config).not.toContain('agents:')
      expect(configNamesAgent(config)).toBe(false)
      const lines = info.mock.calls.map((call) => String(call[0]))
      expect(lines).toContain('Run: bun remove @e2e-dev/acp @agentclientprotocol/claude-agent-acp')
      expect(lines.filter((line) => line.startsWith('Run: bun add') && line.includes('acp'))).toEqual([])
      // --no-install left the packages declared; the config, which names no agent, is what the spec follows.
      expect(none.mapped.changed).toContain(SPEC)
      const spec = await readFile(join(workspace.dir, SPEC), 'utf8')
      expect(spec).not.toContain('agent.act')
      expect(spec).toContain(`test.skip('AC-posts-update-1: does AC-posts-update-1: needs an agent step, since the plan does not name every control it touches, and the config names no agent (${BEHAVIOURS_CONFIG} imports no executor from @e2e-dev/acp, or the app does not declare it)'`)
      expect(spec).toContain("await screen.getByRole('button', 'Create').or(screen.getByRole('link', 'Create')).tap()")
      expect(await readFile(join(workspace.dir, BEHAVIOURS_GIVEN_FILE), 'utf8')).toBe('// mine\n')
      expect(await readFile(join(workspace.dir, '.e2e/cache/recorded.json'), 'utf8')).toBe('{}\n')

      // A later browser:map reads the same config, so it agrees and has nothing to change.
      const later = await runBrowserMap({ cwd: workspace.dir, write: false, map: mapOf(plan), plans })
      expect(later.changed.filter((file) => file.startsWith('tests/'))).toEqual([])

      // And back: the config names the agent again, so the agent step returns.
      await run('claude-code')
      expect(await readFile(join(workspace.dir, SPEC), 'utf8')).toContain('await agent.act(')
    } finally {
      info.mockRestore()
      await workspace.cleanup()
    }
  })

  test('a config names an agent only by importing a value from @e2e-dev/acp', async () => {
    const shipped = await readFile(join(TEMPLATE_ROOT, BEHAVIOURS_CONFIG), 'utf8')
    expect(configNamesAgent(shipped)).toBe(true)
    expect(configNamesAgent(agentConfig({ path: BEHAVIOURS_CONFIG, contents: shipped }, 'codex').contents)).toBe(true)
    const none = agentConfig({ path: BEHAVIOURS_CONFIG, contents: shipped }, 'none').contents
    expect(configNamesAgent(none)).toBe(false)
    expect(configNamesAgent(`// import { claudeCode } from '@e2e-dev/acp'\n${none}`)).toBe(false)
    expect(configNamesAgent(`import type { Executor } from '@e2e-dev/acp'\n${none}`)).toBe(false)
    expect(configNamesAgent(`import { type Executor } from '@e2e-dev/acp'\n${none}`)).toBe(false)
    expect(configNamesAgent('import { claudeCode } from \'@e2e-dev/acp\'\nexport default {')).toBe(false)
  })

  test('a blueprint about to write the files and install the runner is answered as if the four conditions held', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-behaviours-planned-')
    try {
      const plan = planOf([STORE])
      const ask = (): ReturnType<typeof runBrowserMap> => runBrowserMap({ cwd: workspace.dir, write: false, map: mapOf(plan), plans: [{ file: FILE, plan }], behaviours: { signIn: true, agent: true } })
      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app" }\n' })

      const asked = await ask()
      expect(asked.behavioursOff).toBeUndefined()
      expect(asked.changed).toContain(SPEC)
      expect(await Bun.file(join(workspace.dir, SPEC)).exists()).toBe(false)

      await writeWorkspaceFiles(workspace.dir, { [SPEC]: '// mine\n' })
      await expect(ask()).rejects.toThrow(`${SPEC}: it has no generated header, so it is yours`)
    } finally {
      await workspace.cleanup()
    }
  })

  test('browser:map refuses an author\'s spec that differs from a generated one only by the case of its suffix', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-behaviours-case-')
    try {
      const plan = planOf([STORE])
      const mine = `${GENERATED_BEHAVIOURS_DIR}/posts.E2E.ts`
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': '{ "name": "app", "devDependencies": { "e2e": "0.23.1", "@e2e-dev/web": "0.16.0" } }\n',
        [BEHAVIOURS_CONFIG]: '// config\n', [BEHAVIOURS_GIVEN_FILE]: '// given\n', [mine]: '// mine\n',
      })
      await expect(runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf(plan), plans: [{ file: FILE, plan }] })).rejects.toThrow('only by case')
      expect(await readFile(join(workspace.dir, mine), 'utf8')).toBe('// mine\n')
    } finally {
      await workspace.cleanup()
    }
  })
})
