import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'

import {
  BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP, buildBehaviourSpecs, GENERATED_BEHAVIOURS_DIR,
} from '../src/browser-behaviour-specs'
import { isParameterless, type ApprovedPlanInput, type BrowserFeature, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from '../src/browser-map'
import { runBrowserMap } from '../src/browser-map-files'
import { BROWSER_TESTS_CONFIG, GENERATED_HEADER } from '../src/browser-specs'
import { PlanDraftSchema, type Plan, type PlanAcceptance } from '../src/plan/schema'
import { PLAN_VERSION } from '../src/plan/version'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const transpiler = new Bun.Transpiler({ loader: 'ts' })
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

function generate(acceptance: PlanAcceptance[], options: { signIn?: boolean; routes?: BrowserMapRoute[]; map?: Partial<BrowserMap>; views?: ViewInput[] } = {}) {
  const plan = planOf(acceptance, options.views)
  const plans: ApprovedPlanInput[] = [{ file: FILE, plan }]
  return buildBehaviourSpecs(mapOf(plan, options.routes, options.map), plans, { signIn: options.signIn ?? true }, new Map())
}

const contentsOf = (acceptance: PlanAcceptance[], options?: Parameters<typeof generate>[1]): string => generate(acceptance, options).files[0]!.contents

const STORE = behaviour('AC-posts-store-1', 'store', { description: 'a signed-in user creates a post', input: input({ title: 'First' }), expect: { redirect: '/posts/:id', inertia: 'view.posts.show' } })

describe('the behaviour specs', () => {
  test('write one test per behaviour a view sends: the start page, one agent step, then locators', () => {
    const { files, unlabelled } = generate([STORE])
    expect(files.map((entry) => entry.path)).toEqual([SPEC])
    const contents = files[0]!.contents
    expect(contents.startsWith(GENERATED_HEADER)).toBe(true)
    expect(contents).toMatch(/test\('AC-posts-store-1 \([0-9a-f]{6}\): a signed-in user creates a post', \{ session: 'browser' \}, async \(\{ app, agent, screen, browser \}\) => \{/u)
    expect(contents).toContain("const start = await begin('AC-posts-store-1', undefined, { app, browser })")
    expect(contents).toContain("await app.open('/posts/create')")
    expect(contents).toContain(`await agent.act('set "Title" to {title}, then use "Create"', { params: { title: 'First' } })`)
    expect(contents).toContain("await expect(browser).toHaveURL(landed(['/posts/', { not: ['create'] }], start))")
    expect(contents).toContain("await expect(screen.getByRole('button', 'Edit').or(screen.getByRole('link', 'Edit')).first()).toBeVisible()")
    expect(contents).not.toContain('agent.assert')
    expect(contents).not.toMatch(/\[AC-/u)
    expect(unlabelled).toEqual([])
    expect(() => transpiler.transformSync(contents)).not.toThrow()
  })

  test('accept a dialog for the length of the step, after the locale check', () => {
    const body = contentsOf([STORE]).split("test('AC-posts-store-1")[1]!
    const order = ['await expectDefaultLocale(browser)', "const off = await browser.onDialog('accept')", 'await agent.act(', 'await off()', 'await expect(browser)']
    const positions = order.map((line) => body.indexOf(line))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
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
    expect(contents).toContain(`await agent.act('set "Title" to {title}, then submit the form', { params: { title: 'Again' } })`)
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
    expect(contents).toContain(`await agent.act('use "Delete"')`)
    expect(contents).toContain("await expect(browser).toHaveURL('/posts')")
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
    const fields = [titleField, { field: 'rating', label: 'Rating', input: 'number' }, { field: 'email', label: 'Email', input: 'text' }] as const
    const views = withView('view.posts.new', { form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [...fields] } })
    const validation = behaviour('AC-posts-store-3', 'store', { kind: 'validation', expect: { errors: ['title'] } })
    const stopped = [{ title: '' }, { title: null }, { body: 'x' }, { title: 'Hi', rating: 0 }, { title: 'Hi', rating: 1.5 }, { title: 'Hi', rating: '3' }, { title: 'Hi', email: 'nope' }, { title: 'a title past twelve' }]
    for (const values of stopped) {
      expect(skipped({ ...validation, input: input(values) }, { views })).toContain('its input is one a control of the form may stop or change')
    }
    const written = contentsOf([{ ...validation, input: input({ title: '   ', rating: 3, email: 'a@b.test' }) }], { views })
    expect(written).toContain("toHaveAttribute('aria-invalid', 'true')")
  })

  test('an outcome no browser can check', () => {
    expect(skipped({ ...STORE, expect: { status: 302, database: [{ table: 'posts', has: [{ name: 'title', json: '"First"' }] }] } })).toContain('no outcome a browser can check')
    expect(skipped({ ...STORE, kind: 'validation', input: input({ title: '   ' }), expect: { errors: ['authorId'] } })).toContain('no outcome a browser can check')
    expect(skipped({ ...STORE, expect: { redirect: '/posts/create', inertia: 'view.posts.new' } })).toContain('already showed before the step')
  })
})

describe('the spec files', () => {
  test('one per plan with a behaviour, none for a plan with none, and a shared slug refuses', () => {
    expect(generate([]).files).toEqual([])
    const plan = planOf([STORE])
    expect(() => buildBehaviourSpecs(mapOf(plan), [{ file: FILE, plan }], { signIn: true }, new Map([['posts', [FILE, 'posts.plan.json']]]))).toThrow('share the slug posts')
  })

  test('browser:map writes them on its four conditions, whatever the Playwright config, and removes them when one goes', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-behaviours-')
    try {
      const stale = `${GENERATED_BEHAVIOURS_DIR}/gone.e2e.ts`
      const declared = '{ "name": "app", "devDependencies": { "e2e": "0.23.1", "@e2e-dev/web": "0.16.0" } }\n'
      const plan = planOf([STORE])
      const run = (): ReturnType<typeof runBrowserMap> => runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf(plan), plans: [{ file: FILE, plan }] })

      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app", "devDependencies": { "e2e": "0.23.1" } }\n' })
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
})
