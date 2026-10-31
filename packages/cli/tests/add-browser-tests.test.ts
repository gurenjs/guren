import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { addBrowserTests, BROWSER_TEST_SCRIPT } from '../src/add-browser-tests'
import { isParameterless, type BrowserFeature, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from '../src/browser-map'
import { runBrowserMap } from '../src/browser-map-files'
import {
  A11Y_OPTIONS_FILE, A11Y_SPEC_FILE, BROWSER_ACCOUNT_EMAIL, BROWSER_SEEDER_FILE, BROWSER_TESTS_CONFIG, buildA11ySpec, buildBrowserSeeder, buildPlanSpecs,
  buildSmokeSpec, GENERATED_HEADER, SMOKE_SPEC_FILE,
} from '../src/browser-specs'
import { buildLoginViewTemplate } from '../src/make-auth'
import type { PlanView } from '../src/plan/schema'
import { checkTypes, createTempWorkspace, ENV_SCHEMA_FIXTURE, seedInertiaApp, templateCompilerOptions, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'

const CLI_ROOT = join(import.meta.dir, '..')
const TEMPLATE_ROOT = join(CLI_ROOT, 'templates/scaffold/browser-tests')
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const template = (path: string): Promise<string> => readFile(join(TEMPLATE_ROOT, path), 'utf8')

function route(method: string, path: string, pages: string[], authentication?: BrowserMapRoute['authentication']): BrowserMapRoute {
  return { method, path, middleware: authentication === 'required' ? ['auth'] : [], pages, ...(authentication ? { authentication } : {}) }
}

function feature(name: string, routes: BrowserMapRoute[], views: BrowserMapView[] = []): BrowserFeature {
  const landmark = routes.find((entry) => entry.method === 'GET' && entry.pages.length > 0 && isParameterless(entry.path))
  return {
    name, file: `docs/browser/${name}.md`, pages: [...new Set(routes.flatMap((entry) => entry.pages))], routes,
    ...(landmark ? { landmark } : {}), entities: [], acceptance: [], views,
  }
}

function mapOf(features: BrowserFeature[], unplacedViews: BrowserMapView[] = []): BrowserMap {
  return {
    complete: true, gaps: [], features, unreached: [], unassigned: [], unresolvedRenders: [], unplaced: [], unplacedViews, plans: [], unreadablePlans: [],
  }
}

function view(id: string, page: string, overrides: Partial<PlanView> = {}): PlanView {
  return { id, change: { kind: 'add' }, page, purpose: 'Write a comment.', props: [], actions: [], states: {}, ...overrides }
}

const POSTS = feature('posts', [route('GET', '/posts', ['posts/Index']), route('GET', '/posts/:id', ['posts/Show'])])
const DASHBOARD = feature('dashboard', [route('GET', '/dashboard', ['Dashboard'], 'required')])
const AUTH = feature('auth', [route('GET', '/login', ['auth/Login'], 'guest-only'), route('POST', '/login', [])])
const COMMENTS = feature('comments', [route('GET', '/comments/:id', ['comments/Show'])])

describe('the smoke spec', () => {
  test('visits each landmark and compares the component the server rendered', () => {
    const source = buildSmokeSpec(mapOf([POSTS, AUTH]), { signIn: true })
    expect(source.startsWith(GENERATED_HEADER)).toBe(true)
    expect(source).toContain("test('posts: GET /posts renders posts/Index', async ({ page }) => {")
    expect(source).toContain("expect(await initialComponent(page)).toBe('posts/Index')")
    expect(source).toContain("const response = await page.goto('/login')")
    expect(source).not.toContain('signed in')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('puts a route requiring a user under the signed-in storage state', () => {
    const source = buildSmokeSpec(mapOf([DASHBOARD]), { signIn: true })
    expect(source).toContain("import { AUTH_FILE, initialComponent } from '../support'")
    expect(source).toContain("test.describe('signed in', () => {\n  test.use({ storageState: AUTH_FILE })\n\n  test('dashboard: GET /dashboard renders Dashboard'")
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('never visits a route requiring a user as a guest, nor a feature with no landmark', () => {
    const source = buildSmokeSpec(mapOf([DASHBOARD, COMMENTS]), { signIn: false })
    expect(source).toContain("test.fixme('dashboard: GET /dashboard renders Dashboard: needs a signed-in user")
    expect(source).toContain("test.fixme('comments: every route rendering it takes a path parameter', () => {})")
    expect(source).toContain("import { test } from '@playwright/test'")
    expect(source).not.toContain('../support')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('says so when the map has no feature', () => {
    expect(buildSmokeSpec(mapOf([]), { signIn: false })).toContain("test.fixme('the browser map has no feature to check yet', () => {})")
  })
})

describe('the plan specs', () => {
  const create = view('comments.create', 'comments/Create', {
    form: {
      validator: 'validator.comment',
      submitsTo: 'route.comments.store',
      fields: [
        { field: 'body', label: 'Comment', input: 'textarea' },
        { field: 'postId', label: 'Post', input: 'hidden' },
      ],
    },
    actions: [{ label: "Post it's", route: 'route.comments.store' }],
  })
  const plan = 'docs/plans/comments/plan.json'
  const newComment = route('GET', '/comments/new', ['comments/Create'])

  test('checks each form label and action name on the page that renders the view', () => {
    const map = mapOf([feature('comments', [newComment], [{ plan, view: create, routes: [newComment] }])])
    const [spec] = buildPlanSpecs(map, { signIn: false }, new Map())
    expect(spec!.path).toBe('tests/browser/generated/plans/comments.browser.ts')
    expect(spec!.contents).toContain("test('view comments.create (comments/Create) on GET /comments/new', async ({ page }) => {")
    expect(spec!.contents).toContain("await expect(page.getByLabel('Comment', { exact: true }).filter({ visible: true }).first()).toBeVisible()")
    expect(spec!.contents).not.toContain("getByLabel('Post'")
    expect(spec!.contents).toContain("page.getByRole('button', { name: 'Post it\\'s', exact: true }).or(page.getByRole('link', { name: 'Post it\\'s', exact: true })).filter({ visible: true }).first()")
    expect(spec!.contents).toContain("from '../../support'")
    expect(() => transpiler.transformSync(spec!.contents)).not.toThrow()
  })

  test('carries no bracketed acceptance id, so plan:verify never reads it as a behaviour test', () => {
    const map = mapOf([feature('comments', [newComment], [{ plan, view: { ...create, id: 'AC-comments-1' }, routes: [newComment] }])])
    expect(buildPlanSpecs(map, { signIn: false }, new Map())[0]!.contents).not.toMatch(/\[AC-/u)
  })

  test('marks a view it cannot open as fixme, keeps one no feature holds, and leaves a dropped view out', () => {
    const showRoute = route('GET', '/comments/:id', ['comments/Show'])
    const views: BrowserMapView[] = [
      { plan, view: view('comments.show', 'comments/Show'), routes: [showRoute] },
      { plan, view: view('comments.edit', 'comments/Edit'), routes: [] },
      { plan, view: view('comments.old', 'comments/Old', { change: { kind: 'drop', reason: 'merged into show' } }), routes: [] },
    ]
    const invoices: BrowserMapView = { plan, view: view('invoices.create', 'invoices/Create'), routes: [] }
    const contents = buildPlanSpecs(mapOf([feature('comments', [showRoute], views)], [invoices]), { signIn: false }, new Map())[0]!.contents
    expect(contents).toContain("test.fixme('view comments.show (comments/Show): GET /comments/:id takes a path parameter; open a record to check it', () => {})")
    expect(contents).toContain("test.fixme('view comments.edit (comments/Edit): no GET route renders it yet', () => {})")
    expect(contents).toContain("test.fixme('view invoices.create (invoices/Create): no GET route renders it yet', () => {})")
    expect(contents).not.toContain('comments.old')
  })

  test('refuses a plan whose slug another discovered plan shares, approved or not', () => {
    const shared = new Map([['comments', ['comments.plan.json', 'docs/plans/comments/plan.json']]])
    const views: BrowserMapView[] = [{ plan: 'comments.plan.json', view: create, routes: [] }]
    expect(() => buildPlanSpecs(mapOf([], views), { signIn: false }, shared)).toThrow('comments.plan.json, docs/plans/comments/plan.json share the slug comments')
    expect(buildPlanSpecs(mapOf([], views), { signIn: false }, new Map())).toHaveLength(1)
  })
})

describe('the accessibility spec', () => {
  const plan = 'docs/plans/comments/plan.json'
  const newComment = route('GET', '/comments/new', ['comments/Create'])
  const indexView: BrowserMapView = { plan, view: view('posts.index', 'posts/Index'), routes: [route('GET', '/posts', ['posts/Index'])] }

  test('checks each landmark and each view the other specs open, visiting a route once', () => {
    const create: BrowserMapView = { plan, view: view('comments.create', 'comments/Create'), routes: [newComment] }
    const source = buildA11ySpec(mapOf([POSTS], [indexView, create]), { signIn: false })
    expect(source.startsWith(GENERATED_HEADER)).toBe(true)
    expect(source).toContain("import { expect, test, type Page, type TestInfo } from '@playwright/test'")
    expect(source).toContain("import { AxeBuilder } from '@axe-core/playwright'")
    expect(source).toContain("import { a11y } from '../a11y'")
    expect(source).toContain("const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']")
    expect(source).toContain("test('a11y posts: GET /posts renders posts/Index', async ({ page }, testInfo) => {")
    expect(source).toContain("test('a11y view comments.create (comments/Create) on GET /comments/new', async ({ page }, testInfo) => {")
    expect(source).not.toContain('view posts.index')
    expect(source.match(/await checkAccessibility\(page, testInfo\)/gu)).toHaveLength(2)
    expect(source).toContain('expect(violations, ')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('marks what the smoke spec cannot visit as fixme, for the same reason', () => {
    const source = buildA11ySpec(mapOf([DASHBOARD, COMMENTS]), { signIn: false })
    expect(source).toContain("test.fixme('a11y dashboard: GET /dashboard renders Dashboard: needs a signed-in user")
    expect(source).toContain("test.fixme('a11y comments: every route rendering it takes a path parameter', () => {})")
    expect(source).not.toContain('@axe-core/playwright')
    expect(source).not.toContain('checkAccessibility')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('writes a fixme two plans share once, since Playwright refuses a file with a duplicate title', () => {
    const showRoute = route('GET', '/posts/:id', ['posts/Show'])
    const shared = ['docs/plans/a/plan.json', 'docs/plans/b/plan.json'].map((file): BrowserMapView => ({ plan: file, view: view('posts.show', 'posts/Show'), routes: [showRoute] }))
    const source = buildA11ySpec(mapOf([], shared), { signIn: false })
    expect(source.match(/test\.fixme\('a11y view posts\.show/gu)).toHaveLength(1)
  })

  test('typechecks against Playwright and axe beside the templates it imports', async () => {
    const workspace = await createTempWorkspace('guren-a11y-spec-types-')
    try {
      const files = {
        [A11Y_SPEC_FILE]: buildA11ySpec(mapOf([POSTS, DASHBOARD, COMMENTS]), { signIn: true }),
        [A11Y_OPTIONS_FILE]: await template(A11Y_OPTIONS_FILE),
        'tests/browser/support.ts': await template('tests/browser/support.ts'),
      }
      await writeWorkspaceFiles(workspace.dir, files)
      const diagnostics = checkTypes(Object.keys(files).map((file) => join(workspace.dir, file)), {
        ...templateCompilerOptions({
          '@playwright/test': [join(CLI_ROOT, 'node_modules/@playwright/test')],
          '@axe-core/playwright': [join(CLI_ROOT, 'node_modules/@axe-core/playwright')],
        }),
        types: ['bun-types', 'node'],
      })
      expect(diagnostics).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  }, TSC_TIMEOUT)

  test('puts a route requiring a user under the signed-in storage state', () => {
    const source = buildA11ySpec(mapOf([DASHBOARD]), { signIn: true })
    expect(source).toContain("  test('a11y dashboard: GET /dashboard renders Dashboard', async ({ page }, testInfo) => {")
    expect(source).toContain("import { AUTH_FILE, initialComponent } from '../support'")
  })
})

describe('the browser account seeder', () => {
  test('writes nothing without the flag browser:serve sets, nor in production', () => {
    const source = buildBrowserSeeder('pg', { name: true, emailVerifiedAt: false })
    expect(source).toContain("if (process.env.GUREN_BROWSER_SEED !== '1' || process.env.NODE_ENV === 'production') return")
    expect(source).toContain('PostgresSeederContext')
    expect(source).toContain(".values({ name: 'Browser Tests', email: 'browser@example.test', passwordHash })")
    expect(source).toContain('.onConflictDoUpdate({ target: users.email, set: { passwordHash } })')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('keeps the account verified where the table has the column, and upserts the dialect\'s way', () => {
    const sqlite = buildBrowserSeeder('sqlite', { name: true, emailVerifiedAt: true })
    expect(sqlite).toContain('SqliteSeederContext')
    expect(sqlite).toContain('.onConflictDoUpdate({ target: users.email, set: { passwordHash, emailVerifiedAt: verifiedAt } })')
    const mysql = buildBrowserSeeder('mysql', { name: false, emailVerifiedAt: true })
    expect(mysql).toContain(".values({ email: 'browser@example.test', passwordHash, emailVerifiedAt: verifiedAt })")
    expect(mysql).toContain('.onDuplicateKeyUpdate({ set: { passwordHash, emailVerifiedAt: verifiedAt } })')
    expect(() => transpiler.transformSync(mysql)).not.toThrow()
  })
})

describe('what the templates restate', () => {
  test('the run name is the one browser:record --begin writes', async () => {
    const recorder = await readFile(join(import.meta.dir, '../src/browser-record.ts'), 'utf8')
    const pattern = /const RUN_NAME = (\/.+\/u)\n/u
    expect(pattern.exec(await template(BROWSER_TESTS_CONFIG))?.[1]).toBe(pattern.exec(recorder)![1]!)
  })

  test('the account email is the one the seeder writes', async () => {
    expect(await template('tests/browser/support.ts')).toContain(`export const BROWSER_ACCOUNT_EMAIL = '${BROWSER_ACCOUNT_EMAIL}'`)
  })

  test('the setup project signs in through the labels make:auth writes', async () => {
    const setup = await template('tests/browser/auth.setup.ts')
    const page = buildLoginViewTemplate(true, true)
    for (const label of ['Email', 'Password']) {
      expect(setup).toContain(`getByLabel('${label}')`)
      expect(page).toMatch(new RegExp(`<label[^>]*>\\s*${label}\\s*</label>`, 'u'))
    }
    expect(setup).toContain("getByRole('button', { name: 'Sign in', exact: true })")
    expect(page).toMatch(/<button[^>]*>\s*Sign in\s*<\/button>/u)
  })
})

const USERS_SCHEMA = `import { pgTable, serial, text } from '@guren/orm/drizzle/pg'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
})
`
const INERTIA_MANIFEST = '{ "name": "app", "dependencies": { "@guren/inertia-client": "*" } }\n'

describe('guren add browser-tests', () => {
  test('writes the templates as they ship, the script, the ignores, and the smoke spec through browser:map', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST })
      const result = await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })

      expect(result.signIn).toBe(false)
      for (const file of [BROWSER_TESTS_CONFIG, 'tests/browser/support.ts', A11Y_OPTIONS_FILE]) {
        expect(await readFile(join(workspace.dir, file), 'utf8')).toBe(await template(file))
      }
      expect(await Bun.file(join(workspace.dir, 'tests/browser/auth.setup.ts')).exists()).toBe(false)
      expect(await Bun.file(join(workspace.dir, BROWSER_SEEDER_FILE)).exists()).toBe(false)
      const manifest = JSON.parse(await readFile(join(workspace.dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
      expect(manifest.scripts[BROWSER_TEST_SCRIPT.name]).toBe('playwright test -c playwright.browser.config.ts')
      const gitignore = await readFile(join(workspace.dir, '.gitignore'), 'utf8')
      for (const entry of ['test-results/', 'playwright-report/', 'tests/browser/.auth/']) expect(gitignore.split('\n')).toContain(entry)
      expect(result.mapped.changed).toContain(SMOKE_SPEC_FILE)
      expect(await readFile(join(workspace.dir, SMOKE_SPEC_FILE), 'utf8')).toBe(buildSmokeSpec(mapOf([POSTS]), { signIn: false }))
      // Not installed (--no-install), so no accessibility spec that would fail to import.
      expect(result.mapped.accessibilityOff).toBe('@axe-core/playwright is not in package.json')
      expect(await Bun.file(join(workspace.dir, A11Y_SPEC_FILE)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('signs in only on a password users table and a POST /login, and declares the password where config/env.ts exists', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-auth-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': INERTIA_MANIFEST,
        'db/schema.ts': USERS_SCHEMA,
        '.env.example': 'APP_KEY=\n',
        'config/env.ts': ENV_SCHEMA_FIXTURE,
      })
      const result = await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS, AUTH]) })
      expect(result.signIn).toBe(true)
      expect(result.seedsOnBoot).toBe(false)
      expect(await readFile(join(workspace.dir, 'tests/browser/auth.setup.ts'), 'utf8')).toBe(await template('tests/browser/auth.setup.ts'))
      expect(await readFile(join(workspace.dir, BROWSER_SEEDER_FILE), 'utf8')).toBe(buildBrowserSeeder('pg', { name: true, emailVerifiedAt: false }))
      expect(await readFile(join(workspace.dir, '.env.example'), 'utf8')).toContain('\nBROWSER_TEST_PASSWORD=\n')
      expect(await readFile(join(workspace.dir, 'config/env.ts'), 'utf8')).toMatch(/BROWSER_TEST_PASSWORD: Env\.string\(\)/u)
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses a test:browser script running something else, writing nothing', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-script-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app", "scripts": { "test:browser": "playwright test" } }\n' })
      await expect(addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })).rejects.toThrow('already has a test:browser script')
      expect(await Bun.file(join(workspace.dir, BROWSER_TESTS_CONFIG)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses what browser:map would refuse before writing anything', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-slug-')
    try {
      await seedInertiaApp(workspace.dir)
      // The collision is read from the plan files discovery finds, not from the map.
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST, 'comments.plan.json': '{}', 'docs/plans/comments/plan.json': '{}' })
      const shared = ['comments.plan.json', 'docs/plans/comments/plan.json'].map((plan): BrowserMapView => ({ plan, view: view('comments.create', 'comments/Create'), routes: [] }))
      await expect(addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS], shared) })).rejects.toThrow('share the slug comments')
      expect(await readFile(join(workspace.dir, 'package.json'), 'utf8')).toBe(INERTIA_MANIFEST)
      expect(await Bun.file(join(workspace.dir, BROWSER_TESTS_CONFIG)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses an API-only app', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-api-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "api" }\n', 'routes/api.ts': 'export default () => {}\n' })
      await expect(addBrowserTests({ install: false, loadMap: async () => mapOf([]) })).rejects.toThrow('no @guren/inertia-client dependency')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('browser:map keeps the generated specs', () => {
  test('rewrites them once the config exists, removes a generated one nothing produces, and keeps the author\'s', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-specs-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'tests/browser/generated/plans/gone.browser.ts': `${GENERATED_HEADER}\n` })
      const before = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })
      expect(before.changed.filter((file) => file.startsWith('tests/'))).toEqual([])

      await writeWorkspaceFiles(workspace.dir, { [BROWSER_TESTS_CONFIG]: '// config\n', 'tests/browser/generated/plans/mine.browser.ts': '// mine\n' })
      const run = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })
      expect(run.changed).toContain(SMOKE_SPEC_FILE)
      expect(run.removed).toEqual(['tests/browser/generated/plans/gone.browser.ts'])
      expect(await Bun.file(join(workspace.dir, 'tests/browser/generated/plans/gone.browser.ts')).exists()).toBe(false)
      expect(await readFile(join(workspace.dir, 'tests/browser/generated/plans/mine.browser.ts'), 'utf8')).toBe('// mine\n')

      const check = await runBrowserMap({ cwd: workspace.dir, write: false, map: mapOf([POSTS, DASHBOARD]) })
      expect(check.changed).toContain(SMOKE_SPEC_FILE)
    } finally {
      await workspace.cleanup()
    }
  })

  test('writes the accessibility spec only with axe declared and the options file present, and removes it when either goes', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-specs-a11y-')
    try {
      const withAxe = '{ "name": "app", "devDependencies": { "@axe-core/playwright": "~4.14.0" } }\n'
      await writeWorkspaceFiles(workspace.dir, { [BROWSER_TESTS_CONFIG]: '// config\n', 'package.json': withAxe })
      const missingOptions = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })
      expect(missingOptions.accessibilityOff).toBe(`${A11Y_OPTIONS_FILE} does not exist`)
      expect(await Bun.file(join(workspace.dir, A11Y_SPEC_FILE)).exists()).toBe(false)

      await writeWorkspaceFiles(workspace.dir, { [A11Y_OPTIONS_FILE]: await template(A11Y_OPTIONS_FILE) })
      const on = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })
      expect(on.accessibilityOff).toBeUndefined()
      expect(on.changed).toContain(A11Y_SPEC_FILE)
      expect(await readFile(join(workspace.dir, A11Y_SPEC_FILE), 'utf8')).toBe(buildA11ySpec(mapOf([POSTS]), { signIn: false }))

      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app" }\n' })
      const off = await runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })
      expect(off.accessibilityOff).toBe('@axe-core/playwright is not in package.json')
      expect(off.removed).toEqual([A11Y_SPEC_FILE])
      expect(await Bun.file(join(workspace.dir, A11Y_SPEC_FILE)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('leaves every generated spec as it is while the map is partial', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-specs-partial-')
    try {
      const planned = `${GENERATED_HEADER}// comments\n`
      await writeWorkspaceFiles(workspace.dir, { [BROWSER_TESTS_CONFIG]: '// config\n', 'tests/browser/generated/plans/comments.browser.ts': planned })
      const partial = { ...mapOf([POSTS]), unreadablePlans: [{ plan: 'docs/plans/comments/plan.json', reason: 'it does not parse' }] }
      const run = await runBrowserMap({ cwd: workspace.dir, write: true, map: partial })
      expect(run.specsHeld).toBeDefined()
      expect(run.removed).toEqual([])
      expect(run.changed.filter((file) => file.startsWith('tests/'))).toEqual([])
      expect(await readFile(join(workspace.dir, 'tests/browser/generated/plans/comments.browser.ts'), 'utf8')).toBe(planned)
      expect(await Bun.file(join(workspace.dir, SMOKE_SPEC_FILE)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses a spec whose name differs from a generated one only by case', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-specs-case-')
    try {
      await writeWorkspaceFiles(workspace.dir, { [BROWSER_TESTS_CONFIG]: '// config\n', 'tests/browser/generated/Smoke.browser.ts': '// mine\n' })
      await expect(runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })).rejects.toThrow('only by case')
      expect(await readFile(join(workspace.dir, 'tests/browser/generated/Smoke.browser.ts'), 'utf8')).toBe('// mine\n')
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses to overwrite a spec the author wrote at a generated path', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-specs-author-')
    try {
      await writeWorkspaceFiles(workspace.dir, { [BROWSER_TESTS_CONFIG]: '// config\n', [SMOKE_SPEC_FILE]: '// mine\n' })
      await expect(runBrowserMap({ cwd: workspace.dir, write: true, map: mapOf([POSTS]) })).rejects.toThrow('it has no generated header')
      expect(await readFile(join(workspace.dir, SMOKE_SPEC_FILE), 'utf8')).toBe('// mine\n')
    } finally {
      await workspace.cleanup()
    }
  })
})
