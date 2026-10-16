import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { addBrowserTests, BROWSER_TEST_SCRIPT } from '../src/add-browser-tests'
import type { BrowserFeature, BrowserMap, BrowserMapRoute } from '../src/browser-map'
import { BROWSER_SEEDER_FILE, buildBrowserSeeder, buildPlanSpecs, buildSmokeSpec, GENERATED_HEADER, SMOKE_SPEC_FILE } from '../src/browser-specs'
import type { PlanView } from '../src/plan/schema'
import { createTempWorkspace, seedInertiaApp, writeWorkspaceFiles } from './helpers'

const TEMPLATE_ROOT = join(import.meta.dir, '../templates/scaffold/browser-tests')
const transpiler = new Bun.Transpiler({ loader: 'ts' })

function route(method: string, path: string, pages: string[], authentication?: BrowserMapRoute['authentication']): BrowserMapRoute {
  return { method, path, middleware: authentication === 'required' ? ['auth'] : [], pages, ...(authentication ? { authentication } : {}) }
}

function feature(name: string, routes: BrowserMapRoute[], views: Array<{ plan: string; view: PlanView }> = []): BrowserFeature {
  const landmark = routes.find((entry) => entry.method === 'GET' && entry.pages.length > 0 && !entry.path.includes(':'))
  return {
    name, file: `docs/browser/${name}.md`, pages: [...new Set(routes.flatMap((entry) => entry.pages))], routes,
    ...(landmark ? { landmark } : {}), entities: [], acceptance: [], views,
  }
}

function mapOf(features: BrowserFeature[], unassigned: BrowserMap['unassigned'] = []): BrowserMap {
  return {
    complete: true, gaps: [], features, unreached: [], unassigned, unresolvedRenders: [], unplaced: [], plans: [], unreadablePlans: [],
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
    expect(source).toContain("test.describe('signed in', () => {\n  test.use({ storageState: AUTH_FILE })")
    expect(source).toContain("  test('dashboard: GET /dashboard renders Dashboard', async ({ page }) => {")
  })

  test('never visits a route requiring a user as a guest, nor a feature with no landmark', () => {
    const source = buildSmokeSpec(mapOf([DASHBOARD, COMMENTS]), { signIn: false })
    expect(source).toContain("test.fixme('dashboard: GET /dashboard renders Dashboard needs a signed-in user")
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

  test('checks each form label and action name on the page that renders the view', () => {
    const map = mapOf([feature('comments', [route('GET', '/comments/new', ['comments/Create'])], [{ plan, view: create }])])
    const [spec] = buildPlanSpecs(map, { signIn: false })
    expect(spec!.path).toBe('tests/browser/generated/plans/comments.browser.ts')
    expect(spec!.contents).toContain("test('view comments.create (comments/Create) on GET /comments/new', async ({ page }) => {")
    expect(spec!.contents).toContain("await expect(page.getByLabel('Comment', { exact: true })).toBeVisible()")
    expect(spec!.contents).not.toContain("getByLabel('Post'")
    expect(spec!.contents).toContain("page.getByRole('button', { name: 'Post it\\'s', exact: true }).or(page.getByRole('link', { name: 'Post it\\'s', exact: true })).first()")
    expect(spec!.contents).toContain("from '../../support'")
    expect(() => transpiler.transformSync(spec!.contents)).not.toThrow()
  })

  test('carries no bracketed acceptance id, so plan:verify never reads it as a behaviour test', () => {
    const map = mapOf([feature('comments', [route('GET', '/comments/new', ['comments/Create'])], [{ plan, view: create }])])
    expect(buildPlanSpecs(map, { signIn: false })[0]!.contents).not.toMatch(/\[AC-/u)
  })

  test('marks a view it cannot open as fixme, and leaves a dropped view out', () => {
    const shown = view('comments.show', 'comments/Show')
    const later = view('comments.edit', 'comments/Edit')
    const gone = view('comments.old', 'comments/Old', { change: { kind: 'drop', reason: 'merged into show' } })
    const map = mapOf([feature('comments', [route('GET', '/comments/:id', ['comments/Show'])], [shown, later, gone].map((entry) => ({ plan, view: entry })))])
    const contents = buildPlanSpecs(map, { signIn: false })[0]!.contents
    expect(contents).toContain("test.fixme('view comments.show (comments/Show): GET /comments/:id takes a path parameter; open a record to check it', () => {})")
    expect(contents).toContain("test.fixme('view comments.edit (comments/Edit): no GET route renders it yet', () => {})")
    expect(contents).not.toContain('comments.old')
  })
})

describe('the browser account seeder', () => {
  test('writes nothing without the flag browser:serve sets, nor in production', () => {
    const source = buildBrowserSeeder('pg', { name: true, emailVerifiedAt: false })
    expect(source).toContain("if (process.env.GUREN_BROWSER_SEED !== '1' || process.env.NODE_ENV === 'production') return")
    expect(source).toContain('PostgresSeederContext')
    expect(source).toContain(".values({ name: 'Browser Tests', email: 'browser@example.test', passwordHash })")
    expect(source).toContain('.onConflictDoUpdate({ target: users.email, set: { passwordHash } })')
    expect(source).not.toContain("'secret'")
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test('marks the account verified where the table has the column, and upserts the MySQL way', () => {
    const source = buildBrowserSeeder('mysql', { name: false, emailVerifiedAt: true })
    expect(source).toContain(".values({ email: 'browser@example.test', passwordHash, emailVerifiedAt: new Date() })")
    expect(source).toContain('.onDuplicateKeyUpdate({ set: { passwordHash } })')
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

describe('guren add browser-tests', () => {
  test('writes the templates as they ship, the script, the ignores, and the generated smoke spec', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': '{ "name": "app", "dependencies": { "@guren/inertia-client": "*" } }\n' })
      const result = await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })

      expect(result.signIn).toBe(false)
      for (const file of ['playwright.config.ts', 'tests/browser/support.ts']) {
        expect(await readFile(join(workspace.dir, file), 'utf8')).toBe(await readFile(join(TEMPLATE_ROOT, file), 'utf8'))
      }
      expect(await Bun.file(join(workspace.dir, 'tests/browser/auth.setup.ts')).exists()).toBe(false)
      expect(await Bun.file(join(workspace.dir, BROWSER_SEEDER_FILE)).exists()).toBe(false)
      const manifest = JSON.parse(await readFile(join(workspace.dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
      expect(manifest.scripts[BROWSER_TEST_SCRIPT.name]).toBe(BROWSER_TEST_SCRIPT.command)
      const gitignore = await readFile(join(workspace.dir, '.gitignore'), 'utf8')
      for (const entry of ['test-results/', 'playwright-report/', 'tests/browser/.auth/']) expect(gitignore.split('\n')).toContain(entry)
      expect(await readFile(join(workspace.dir, SMOKE_SPEC_FILE), 'utf8')).toBe(buildSmokeSpec(mapOf([POSTS]), { signIn: false }))
    } finally {
      await workspace.cleanup()
    }
  })

  test('signs in only on a password users table and a POST /login, and rewrites only the generated specs on a re-run', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-auth-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': '{ "name": "app", "dependencies": { "@guren/inertia-client": "*" } }\n',
        'db/schema.ts': USERS_SCHEMA,
        '.env.example': 'APP_KEY=\n',
      })
      await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS, AUTH]) })
      expect(await readFile(join(workspace.dir, 'tests/browser/auth.setup.ts'), 'utf8'))
        .toBe(await readFile(join(TEMPLATE_ROOT, 'tests/browser/auth.setup.ts'), 'utf8'))
      expect(await readFile(join(workspace.dir, BROWSER_SEEDER_FILE), 'utf8')).toBe(buildBrowserSeeder('pg', { name: true, emailVerifiedAt: false }))
      expect(await readFile(join(workspace.dir, '.env.example'), 'utf8')).toContain('\nBROWSER_TEST_PASSWORD=\n')

      await writeWorkspaceFiles(workspace.dir, { 'playwright.config.ts': '// edited\n', 'tests/browser/generated/plans/gone.browser.ts': `${GENERATED_HEADER}\n` })
      const rerun = await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS, AUTH, DASHBOARD]) })
      expect(await readFile(join(workspace.dir, 'playwright.config.ts'), 'utf8')).toBe('// edited\n')
      expect(await readFile(join(workspace.dir, SMOKE_SPEC_FILE), 'utf8')).toContain("test('dashboard: GET /dashboard renders Dashboard'")
      expect(rerun.orphans).toEqual(['tests/browser/generated/plans/gone.browser.ts'])
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
