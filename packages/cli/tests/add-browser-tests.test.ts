import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { addBrowserTests, BROWSER_TEST_SCRIPT } from '../src/add-browser-tests'
import { isParameterless, type BrowserFeature, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from '../src/browser-map'
import { runBrowserMap } from '../src/browser-map-files'
import {
  BROWSER_ACCOUNT_EMAIL, BROWSER_SEEDER_FILE, BROWSER_TESTS_CONFIG, buildBrowserSeeder, buildPlanSpecs, buildSmokeSpec, GENERATED_HEADER, SMOKE_SPEC_FILE,
} from '../src/browser-specs'
import { buildLoginViewTemplate } from '../src/make-auth'
import type { PlanView } from '../src/plan/schema'
import { createTempWorkspace, ENV_SCHEMA_FIXTURE, seedInertiaApp, writeWorkspaceFiles } from './helpers'

const TEMPLATE_ROOT = join(import.meta.dir, '../templates/scaffold/browser-tests')
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
    const [spec] = buildPlanSpecs(map, { signIn: false })
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
    expect(buildPlanSpecs(map, { signIn: false })[0]!.contents).not.toMatch(/\[AC-/u)
  })

  test('marks a view it cannot open as fixme, keeps one no feature holds, and leaves a dropped view out', () => {
    const showRoute = route('GET', '/comments/:id', ['comments/Show'])
    const views: BrowserMapView[] = [
      { plan, view: view('comments.show', 'comments/Show'), routes: [showRoute] },
      { plan, view: view('comments.edit', 'comments/Edit'), routes: [] },
      { plan, view: view('comments.old', 'comments/Old', { change: { kind: 'drop', reason: 'merged into show' } }), routes: [] },
    ]
    const invoices: BrowserMapView = { plan, view: view('invoices.create', 'invoices/Create'), routes: [] }
    const contents = buildPlanSpecs(mapOf([feature('comments', [showRoute], views)], [invoices]), { signIn: false })[0]!.contents
    expect(contents).toContain("test.fixme('view comments.show (comments/Show): GET /comments/:id takes a path parameter; open a record to check it', () => {})")
    expect(contents).toContain("test.fixme('view comments.edit (comments/Edit): no GET route renders it yet', () => {})")
    expect(contents).toContain("test.fixme('view invoices.create (invoices/Create): no GET route renders it yet', () => {})")
    expect(contents).not.toContain('comments.old')
  })

  test('refuses two plans whose specs would be one file', () => {
    const views = ['comments.plan.json', 'docs/plans/comments/plan.json'].map((file): BrowserMapView => ({ plan: file, view: create, routes: [] }))
    expect(() => buildPlanSpecs(mapOf([], views), { signIn: false })).toThrow('share the slug comments')
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
    for (const label of ['Email', 'Password', 'Sign in']) {
      expect(setup).toContain(`'${label}'`)
      expect(page).toMatch(new RegExp(`>\\s*${label}\\s*<`, 'u'))
    }
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
      for (const file of [BROWSER_TESTS_CONFIG, 'tests/browser/support.ts']) {
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
