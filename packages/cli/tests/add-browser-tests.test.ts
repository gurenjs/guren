import { describe, expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { consola } from 'consola'

import {
  addBrowserTests, BEHAVIOUR_DEV_PACKAGES, BEHAVIOUR_SCRIPTS, behaviourAgent, BROWSER_TEST_SCRIPT, CLAUDE_CODE_ADAPTER, CONFIG_LOCALE_LINE, pinConfigLocale,
} from '../src/add-browser-tests'
import { readAppLocale, type AppLocaleReading } from '../src/app-locale'
import { BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP } from '../src/browser-behaviour-specs'
import { isParameterless, type BrowserFeature, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from '../src/browser-map'
import { runBrowserMap } from '../src/browser-map-files'
import { BROWSER_RUN_NAME } from '../src/browser-record'
import { cliDependencyRange } from '../src/cli-manifest'
import {
  A11Y_OPTIONS_FILE, A11Y_SPEC_FILE, BROWSER_ACCOUNT_EMAIL, BROWSER_SEEDER_FILE, BROWSER_TESTS_CONFIG, buildA11ySpec, buildBrowserSeeder, buildPlanSpecs,
  buildSmokeSpec, GENERATED_HEADER, LOCALE_COOKIE, SMOKE_SPEC_FILE,
} from '../src/browser-specs'
import { buildLoginViewTemplate } from '../src/make-auth'
import { humanizeFieldName } from '../../inertia-client/src/forms'
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

  test('checks the page rendered in the app\'s default locale before it looks for a label', () => {
    const map = mapOf([feature('comments', [newComment], [{ plan, view: create, routes: [newComment] }])])
    const contents = buildPlanSpecs(map, { signIn: false }, new Map())[0]!.contents
    expect(contents).toContain("import { expect, test, type Page } from '@playwright/test'")
    expect(contents).toContain('const shared = initial?.props?._i18n')
    expect(contents).toContain('.toBe(i18n.fallbackLocale)')
    const body = contents.slice(contents.indexOf("test('view comments.create"))
    expect(body.indexOf('await expectDefaultLocale(page)')).toBeGreaterThan(0)
    expect(body.indexOf('await expectDefaultLocale(page)')).toBeLessThan(body.indexOf('getByLabel('))
  })

  test('leaves the locale check out of a file with nothing to open', () => {
    const views: BrowserMapView[] = [{ plan, view: view('comments.edit', 'comments/Edit'), routes: [] }]
    const contents = buildPlanSpecs(mapOf([], views), { signIn: false }, new Map())[0]!.contents
    expect(contents).not.toContain('expectDefaultLocale')
    expect(contents).toContain("import { test } from '@playwright/test'")
  })

  test('typechecks against Playwright beside the support template it imports', async () => {
    const workspace = await createTempWorkspace('guren-plan-spec-types-')
    try {
      const map = mapOf([feature('comments', [newComment], [{ plan, view: create, routes: [newComment] }]), DASHBOARD], [
        { plan, view: view('comments.mine', 'Dashboard', { actions: [{ label: 'Mine', route: 'route.comments.store' }] }), routes: [route('GET', '/dashboard', ['Dashboard'], 'required')] },
      ])
      const [spec] = buildPlanSpecs(map, { signIn: true }, new Map())
      const files = {
        [spec!.path]: spec!.contents,
        'tests/browser/support.ts': await template('tests/browser/support.ts'),
      }
      await writeWorkspaceFiles(workspace.dir, files)
      const diagnostics = checkTypes(Object.keys(files).map((file) => join(workspace.dir, file)), {
        ...templateCompilerOptions({ '@playwright/test': [join(CLI_ROOT, 'node_modules/@playwright/test')] }),
        types: ['bun-types', 'node'],
      })
      expect(diagnostics).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  }, TSC_TIMEOUT)

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

describe('reading the app\'s default locale', () => {
  const entry = (options: string): Record<string, string> => ({ 'src/app.ts': `import { createApp } from '@guren/core'\nexport default createApp(${options})\n` })

  test('tells an app without i18n from one whose locale it cannot read', async () => {
    const workspace = await createTempWorkspace('guren-app-locale-')
    try {
      const cases: Array<[string, AppLocaleReading]> = [
        ["{ routes: () => {}, i18n: { supported: ['ja', 'en'], fallback: 'en' } }", { kind: 'locale', locale: 'en' }],
        ["{ routes: () => {}, i18n: { supported: ['ja', 'en'] } }", { kind: 'locale', locale: 'ja' }],
        ['{ routes: () => {} }', { kind: 'none' }],
        ['{ routes: () => {}, ...shared }', { kind: 'unknown' }],
        ['options', { kind: 'unknown' }],
        ['{ routes: () => {}, i18n }', { kind: 'unknown' }],
        ["{ routes: () => {}, i18n: { ...base, supported: ['ja'] } }", { kind: 'unknown' }],
        ['{ routes: () => {}, i18n: { supported: locales } }', { kind: 'unknown' }],
      ]
      for (const [options, expected] of cases) {
        await writeWorkspaceFiles(workspace.dir, entry(options))
        expect({ options, reading: await readAppLocale(workspace.dir) }).toEqual({ options, reading: expected })
      }
    } finally {
      await workspace.cleanup()
    }
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
    const pattern = /const RUN_NAME = (\/.+\/u)\n/u
    expect(pattern.exec(await template(BROWSER_TESTS_CONFIG))?.[1]).toBe(String(BROWSER_RUN_NAME))
  })

  test('the account email is the one the seeder writes', async () => {
    expect(await template('tests/browser/support.ts')).toContain(`export const BROWSER_ACCOUNT_EMAIL = '${BROWSER_ACCOUNT_EMAIL}'`)
  })

  test('the config sends the locale add browser-tests writes, on one line', async () => {
    const config = await template(BROWSER_TESTS_CONFIG)
    expect(config.split(CONFIG_LOCALE_LINE)).toHaveLength(2)
    expect(config).toContain('    locale: LOCALE,\n')
  })

  test('the setup project clears the locale cookie the server reads by default', async () => {
    const setup = await template('tests/browser/auth.setup.ts')
    expect(setup).toContain(`await context.addCookies(cookies.filter((cookie) => cookie.name !== '${LOCALE_COOKIE}'))`)
    // A filter clearCookies() ignores before Playwright 1.43 would drop the session cookie with it.
    expect(setup).not.toMatch(/\.clearCookies\(\{/u)
    expect(await readFile(join(CLI_ROOT, '../server/src/http/middleware/detect-locale.ts'), 'utf8')).toContain(`const cookieName = options.cookieName ?? '${LOCALE_COOKIE}'`)
  })

  test('the plan spec reads the initial page from the element support.ts falls back to', async () => {
    const selector = `document.querySelector('script[data-page="app"][type="application/json"]')`
    expect(await template('tests/browser/support.ts')).toContain(selector)
    const create = view('posts.create', 'posts/Create', { actions: [{ label: 'Save', route: 'route.posts.store' }] })
    const newPost = route('GET', '/posts/new', ['posts/Create'])
    const map = mapOf([feature('posts', [newPost], [{ plan: 'posts.plan.json', view: create, routes: [newPost] }])])
    expect(buildPlanSpecs(map, { signIn: false }, new Map())[0]!.contents).toContain(selector)
  })

  test('the setup project signs in through the labels make:auth writes', async () => {
    const setup = await template('tests/browser/auth.setup.ts')
    const page = buildLoginViewTemplate(true, true)
    for (const [name, label] of [['email', 'Email'], ['password', 'Password']] as const) {
      expect(setup).toContain(`getByLabel('${label}')`)
      // Given no `label`, Field labels the key with humanizeFieldName().
      expect(page).toMatch(new RegExp(`<Field form=\\{form\\} name="${name}"(?![^>]*label=)[^>]*/>`, 'u'))
      expect(humanizeFieldName(name)).toBe(label)
    }
    expect(setup).toContain("getByRole('button', { name: 'Sign in', exact: true })")
    expect(page).toMatch(/<Button[^>]*>\s*Sign in\s*<\/Button>/u)
  })
})

const CONFIG_PROBE = `import { plugin } from 'bun'

// The executor is opaque once built, so the adapter package is replaced by one that keeps its options.
plugin({
  name: 'keep-executor-options',
  setup(build) {
    build.module('@e2e-dev/acp', () => ({ exports: { claudeCode: (options: unknown) => ({ options }) }, loader: 'object' }))
  },
})

const { default: config } = await import(process.argv[2]!)
const report: Record<string, unknown> = {
  agentEnv: config.agents.default.executor.options.env,
  model: config.agents.default.executor.options.model,
  commandEnv: config.targets[0].app.command.env ?? null,
  inheritEnv: config.targets[0].app.command.inheritEnv,
  credential: config.credentials?.browser?.password ?? null,
  databaseUrl: process.env.DATABASE_URL ?? null,
}
// The runner forks each worker from this process's environment, and the worker loads the config again.
if (!process.env.PROBE_WORKER) {
  const worker = Bun.spawn([process.execPath, ...process.argv.slice(1)], { env: { ...process.env, PROBE_WORKER: '1' }, stdout: 'pipe' })
  report.worker = JSON.parse(await new Response(worker.stdout).text())
}
console.log(JSON.stringify(report))
`

interface ConfigProbe {
  agentEnv: Record<string, string>
  model: string
  commandEnv: Record<string, string> | null
  inheritEnv: string[]
  credential: string | null
  databaseUrl: string | null
  worker?: ConfigProbe
}

/** The shipped config, loaded by a child `bun` in a directory holding `files`, with only `env` beside PATH and HOME. */
async function evaluateConfig(files: Record<string, string>, env: Record<string, string> = {}): Promise<ConfigProbe> {
  const workspace = await createTempWorkspace('guren-behaviours-config-')
  try {
    await writeWorkspaceFiles(workspace.dir, { ...files, 'probe.ts': CONFIG_PROBE })
    const child = Bun.spawn([process.execPath, 'probe.ts', join(TEMPLATE_ROOT, BEHAVIOURS_CONFIG)], {
      cwd: workspace.dir, stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`the config probe exited ${code}: ${stderr}`)
    return JSON.parse(stdout) as ConfigProbe
  } finally {
    await workspace.cleanup()
  }
}

describe('the behaviour config, loaded', () => {
  // Shapes Bun loads that a line parser reads otherwise: CRLF and lone CR line ends, a dashed key, `KEY: value`,
  // a key on the line above its `=`, and a multi-line value holding a line that looks like an assignment.
  const FILES = {
    '.env': 'APP_KEY=app\r\nexport SMTP_PASS="smtp"\r\nMY-DASH=dash\r\nYAML_STYLE: yaml\r\nBROWSER_TEST_PASSWORD=\r\nANTHROPIC_MODEL=other\r\nDATABASE_URL=file\r\n'
      + 'PUBLIC=one\rCR_SECRET=secret\rAFTER=x\nSPLIT_SECRET\n=split\nMULTI="first\nEMBEDDED_NAME=/example\nlast"\n',
    '.env.development.local': 'LOCAL_ONLY=x\n',
    '.env.production': 'PROD_ONLY=y\n',
  }
  const SHELL = { BROWSER_TEST_PASSWORD: 'shellpw123', DATABASE_URL: 'shell', EMBEDDED_NAME: 'shell' }

  test('hands the agent every name an env file sets as an empty string, and keeps the model the executor names', async () => {
    const loaded = await evaluateConfig(FILES, SHELL)
    // Every mode's files, and no EMBEDDED_NAME: Bun reads that line as part of MULTI, so the shell's value stays the agent's.
    expect(Object.keys(loaded.agentEnv).sort()).toEqual([
      'AFTER', 'APP_KEY', 'BROWSER_TEST_PASSWORD', 'CR_SECRET', 'DATABASE_URL', 'LOCAL_ONLY', 'MULTI', 'MY-DASH', 'PROD_ONLY', 'PUBLIC', 'SMTP_PASS', 'SPLIT_SECRET', 'YAML_STYLE',
    ])
    expect(new Set(Object.values(loaded.agentEnv))).toEqual(new Set(['']))
    // The preset spreads these over ANTHROPIC_MODEL, so an emptied one would start the agent on no model.
    expect(loaded.model).toBe('sonnet')
  }, TSC_TIMEOUT)

  test('takes a password the shell exports, and a worker loading the config again reads the same one', async () => {
    const loaded = await evaluateConfig(FILES, SHELL)
    expect(loaded.credential).toBe('shellpw123')
    expect(loaded.commandEnv).toEqual({ BROWSER_TEST_PASSWORD: 'shellpw123' })
    expect(loaded.worker).toEqual({ ...loaded, worker: undefined })
    // Still the shell's after the config loaded, so a name the author adds to inheritEnv reaches the app.
    expect(loaded.databaseUrl).toBe('shell')
    expect(loaded.inheritEnv).toEqual(['NODE_ENV'])
  }, TSC_TIMEOUT)

  test('falls back to the env files for the password, the same in a worker', async () => {
    const loaded = await evaluateConfig({ '.env': 'BROWSER_TEST_PASSWORD="filepw123"\n' })
    expect(loaded.credential).toBe('filepw123')
    expect(loaded.commandEnv).toEqual({ BROWSER_TEST_PASSWORD: 'filepw123' })
    expect(loaded.worker?.credential).toBe('filepw123')
    expect(loaded.agentEnv).toEqual({ BROWSER_TEST_PASSWORD: '' })
  }, TSC_TIMEOUT)

  test('registers no credential the runner would refuse at load, counting code points as it does', async () => {
    for (const password of ['abc', '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}']) {
      const loaded = await evaluateConfig({ '.env': `BROWSER_TEST_PASSWORD=${password}\n` })
      expect(loaded.credential).toBeNull()
      expect(loaded.commandEnv).toEqual({ BROWSER_TEST_PASSWORD: password })
    }
    const unset = await evaluateConfig({})
    expect(unset.credential).toBeNull()
    expect(unset.commandEnv).toBeNull()
    expect(unset.agentEnv).toEqual({ BROWSER_TEST_PASSWORD: '' })
  }, TSC_TIMEOUT)
})

describe('what the behaviour templates restate', () => {
  test('the config names the account the seeder writes and sends the locale add browser-tests writes', async () => {
    const config = await template(BEHAVIOURS_CONFIG)
    expect(config).toContain(`const BROWSER_ACCOUNT_EMAIL = '${BROWSER_ACCOUNT_EMAIL}'`)
    expect(config.split(CONFIG_LOCALE_LINE)).toHaveLength(2)
    expect(config).toContain('engine: web({ locale: LOCALE }),')
  })

  test('the config starts the app through browser:serve on a port of its own and attaches to no server', async () => {
    const config = await template(BEHAVIOURS_CONFIG)
    const port = /const PORT = (\d+)\n/u.exec(config)?.[1]
    expect(port).toBeDefined()
    expect(/const PORT = (\d+)\n/u.exec(await template(BROWSER_TESTS_CONFIG))?.[1]).not.toBe(port)
    expect(config).toContain("args: ['guren', 'browser:serve', '--port', String(PORT)],")
    expect(config).toContain('reuseExisting: false,')
    // browser:serve refuses production on the caller's NODE_ENV, which the runner passes only when named.
    expect(config).toContain("inheritEnv: ['NODE_ENV'],")
  })

  test('the config and the scripts name the tests and the config file browser:map checks for', async () => {
    expect(await template(BEHAVIOURS_CONFIG)).toContain("tests: 'tests/browser/behaviours/**/*.e2e.ts',")
    for (const script of BEHAVIOUR_SCRIPTS) expect(script.command).toContain(`bunx --bun e2e run --config ${BEHAVIOURS_CONFIG}`)
    expect(BEHAVIOUR_SCRIPTS.map((script) => script.command.endsWith(' --strict-cache'))).toEqual([false, true])
  })

  test('the setup signs in through the labels make:auth writes and clears the locale cookie', async () => {
    const setup = await template(BEHAVIOURS_SETUP)
    const page = buildLoginViewTemplate(true, true)
    for (const [name, label] of [['email', 'Email'], ['password', 'Password']] as const) {
      expect(setup).toContain(`screen.getByLabel('${label}')`)
      expect(page).toMatch(new RegExp(`<Field form=\\{form\\} name="${name}"(?![^>]*label=)[^>]*/>`, 'u'))
      expect(humanizeFieldName(name)).toBe(label)
    }
    expect(setup).toContain("screen.getByRole('button', 'Sign in')")
    expect(page).toMatch(/<Button[^>]*>\s*Sign in\s*<\/Button>/u)
    expect(setup).toContain(`await browser.clearCookies({ name: '${LOCALE_COOKIE}' })`)
    expect(setup).toContain("test.setup('sign in as the browser account', { sessions: ['browser'] }")
    expect(setup).toContain("credentials.user('browser')")
    expect(await template(BEHAVIOURS_CONFIG)).toContain('credentials: { browser: {')
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

  test('writes the app\'s default locale into the config', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-locale-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': INERTIA_MANIFEST,
        'src/app.ts': "import { createApp } from '@guren/core'\nimport registerWebRoutes from '../routes/web.js'\n\nexport default createApp({ routes: registerWebRoutes, i18n: { supported: ['ja', 'en'] } })\n",
      })
      await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })
      const config = await readFile(join(workspace.dir, BROWSER_TESTS_CONFIG), 'utf8')
      expect(config).toBe((await template(BROWSER_TESTS_CONFIG)).replace(CONFIG_LOCALE_LINE, "const LOCALE = 'ja'\n"))
    } finally {
      await workspace.cleanup()
    }
  })

  test('keeps en and says so when createApp({ i18n }) is there but cannot be read', async () => {
    const workspace = await createTempWorkspace('guren-add-browser-tests-locale-unread-')
    const warn = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': INERTIA_MANIFEST,
        'src/app.ts': "import { createApp } from '@guren/core'\nimport registerWebRoutes from '../routes/web.js'\nimport { i18n } from '../config/i18n.js'\n\nexport default createApp({ routes: registerWebRoutes, i18n })\n",
      })
      await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })
      expect(await readFile(join(workspace.dir, BROWSER_TESTS_CONFIG), 'utf8')).toBe(await template(BROWSER_TESTS_CONFIG))
      expect(warn.mock.calls.map((args) => String(args[0])).some((message) => message.includes('set LOCALE there'))).toBe(true)
    } finally {
      warn.mockRestore()
      await workspace.cleanup()
    }
  })

  test('refuses a config template that lost its locale line rather than writing en', () => {
    expect(() => pinConfigLocale({ path: BROWSER_TESTS_CONFIG, contents: 'export default {}\n' }, 'ja')).toThrow('no single const LOCALE')
    expect(pinConfigLocale({ path: BROWSER_TESTS_CONFIG, contents: CONFIG_LOCALE_LINE }, "pt-'BR")).toEqual({ path: BROWSER_TESTS_CONFIG, contents: "const LOCALE = 'pt-\\'BR'\n" })
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

describe('guren add browser-tests --behaviours', () => {
  test('needs an agent, since whose login runs the steps has no default', () => {
    expect(behaviourAgent({})).toBeUndefined()
    expect(behaviourAgent({ behaviours: true, agent: 'claude-code' })).toBe('claude-code')
    expect(() => behaviourAgent({ behaviours: true })).toThrow('--behaviours needs --agent claude-code or --agent codex')
    expect(() => behaviourAgent({ agent: 'claude-code' })).toThrow('it goes with --behaviours')
    expect(() => behaviourAgent({ behaviours: true, agent: 'codex' })).toThrow('--agent codex is not available yet')
    expect(() => behaviourAgent({ behaviours: true, agent: 'cursor' })).toThrow('--agent cursor names no agent')
  })

  test('refuses an agent it cannot set up before writing anything', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-agent-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST })
      await expect(addBrowserTests({ install: false, behaviours: true, agent: 'codex', loadMap: async () => mapOf([POSTS]) })).rejects.toThrow('Nothing was written')
      expect(await readFile(join(workspace.dir, 'package.json'), 'utf8')).toBe(INERTIA_MANIFEST)
      expect(await Bun.file(join(workspace.dir, BROWSER_TESTS_CONFIG)).exists()).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  test('writes the config, given.ts, both scripts and the ignores beside the Playwright files, and names what to install', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-')
    const info = spyOn(consola, 'info').mockImplementation((() => {}) as never)
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST })
      const result = await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })

      expect(result.behaviours).toBe('claude-code')
      for (const file of [BROWSER_TESTS_CONFIG, BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE]) {
        expect(await readFile(join(workspace.dir, file), 'utf8')).toBe(await template(file))
      }
      // No password sign-in, so no setup that would fail every run.
      expect(await Bun.file(join(workspace.dir, BEHAVIOURS_SETUP)).exists()).toBe(false)
      const manifest = JSON.parse(await readFile(join(workspace.dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
      for (const script of [BROWSER_TEST_SCRIPT, ...BEHAVIOUR_SCRIPTS]) expect(manifest.scripts[script.name]).toBe(script.command)
      // The negation has to follow the pattern it re-includes from, and `.e2e/` would hide the recordings from it.
      const ignored = (await readFile(join(workspace.dir, '.gitignore'), 'utf8')).split('\n')
      expect(ignored.indexOf('.e2e/*')).toBeGreaterThanOrEqual(0)
      expect(ignored.indexOf('!.e2e/cache/')).toBeGreaterThan(ignored.indexOf('.e2e/*'))
      expect(ignored).not.toContain('.e2e/')

      const install = info.mock.calls.map((call) => String(call[0])).find((line) => line.startsWith('Run: bun add -d '))
      for (const name of BEHAVIOUR_DEV_PACKAGES) expect(install).toContain(` ${name}@${cliDependencyRange('devDependencies', name)}`)
      expect(install).toContain(` ${CLAUDE_CODE_ADAPTER.name}@${CLAUDE_CODE_ADAPTER.range}`)
      // Not installed (--no-install), so no behaviour spec that would fail to import.
      expect(result.mapped.behavioursOff).toBe('e2e and @e2e-dev/web are not in package.json')
    } finally {
      info.mockRestore()
      await workspace.cleanup()
    }
  })

  test('pins the runner to exact versions, since a patch may give every recording a new key', () => {
    for (const name of BEHAVIOUR_DEV_PACKAGES) expect(cliDependencyRange('devDependencies', name)).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  test('adds the sign-in setup on a password sign-in, and on an app that already has the Playwright files', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-auth-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST, 'db/schema.ts': USERS_SCHEMA })
      const loadMap = async (): Promise<BrowserMap> => mapOf([POSTS, AUTH])
      await addBrowserTests({ install: false, loadMap })
      expect(await Bun.file(join(workspace.dir, BEHAVIOURS_CONFIG)).exists()).toBe(false)

      const result = await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap })
      expect(result.signIn).toBe(true)
      expect(result.created.map((file) => relative(process.cwd(), file)).sort()).toEqual([BEHAVIOURS_CONFIG, BEHAVIOURS_SETUP, BEHAVIOURS_GIVEN_FILE].sort())
      expect(await readFile(join(workspace.dir, BEHAVIOURS_SETUP), 'utf8')).toBe(await template(BEHAVIOURS_SETUP))
    } finally {
      await workspace.cleanup()
    }
  })

  test('leaves the author\'s given.ts as it is on a second run', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-rerun-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST, [BEHAVIOURS_GIVEN_FILE]: '// mine\n' })
      await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(await readFile(join(workspace.dir, BEHAVIOURS_GIVEN_FILE), 'utf8')).toBe('// mine\n')
    } finally {
      await workspace.cleanup()
    }
  })

  test('refuses a test:behaviours script running something else, writing nothing', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-script-')
    try {
      await seedInertiaApp(workspace.dir)
      const manifest = '{ "name": "app", "scripts": { "test:behaviours:ci": "e2e run" } }\n'
      await writeWorkspaceFiles(workspace.dir, { 'package.json': manifest })
      await expect(addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })).rejects.toThrow('already has a test:behaviours:ci script')
      expect(await readFile(join(workspace.dir, 'package.json'), 'utf8')).toBe(manifest)
      expect(await Bun.file(join(workspace.dir, BEHAVIOURS_CONFIG)).exists()).toBe(false)
      // Without the option the same manifest is no obstacle: the script is none of the Playwright blueprint's.
      await addBrowserTests({ install: false, loadMap: async () => mapOf([POSTS]) })
    } finally {
      await workspace.cleanup()
    }
  })

  test('--force rewrites the config and never the author\'s given.ts', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-force-')
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST, [BEHAVIOURS_GIVEN_FILE]: '// mine\n', [BEHAVIOURS_CONFIG]: '// edited\n' })
      await addBrowserTests({ install: false, force: true, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(await readFile(join(workspace.dir, BEHAVIOURS_GIVEN_FILE), 'utf8')).toBe('// mine\n')
      expect(await readFile(join(workspace.dir, BEHAVIOURS_CONFIG), 'utf8')).toBe(await template(BEHAVIOURS_CONFIG))
    } finally {
      await workspace.cleanup()
    }
  })

  test('says so when the installed Playwright is older than the playwright-core the runner pins', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-playwright-')
    const warn = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
    const older = (): string[] => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('is older than the playwright-core'))
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': INERTIA_MANIFEST,
        'node_modules/@playwright/test/package.json': '{ "version": "1.62.1" }\n',
        'node_modules/@e2e-dev/web/package.json': '{ "dependencies": { "playwright-core": "1.65.0" } }\n',
      })
      await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(older()).toHaveLength(1)
      expect(older()[0]).toContain('Run: bun add -d @playwright/test@^1.65.0')

      // A workspace install hoists a package above the app; Node's lookup still finds it there.
      warn.mockClear()
      await writeWorkspaceFiles(workspace.dir, { 'packages/app/package.json': INERTIA_MANIFEST })
      await seedInertiaApp(join(workspace.dir, 'packages/app'))
      process.chdir(join(workspace.dir, 'packages/app'))
      await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(older()).toHaveLength(1)
      process.chdir(workspace.dir)

      // The same or a newer Playwright shares its Page with the runner's copy, or adds to it.
      for (const version of ['1.65.0', '1.66.2']) {
        warn.mockClear()
        await writeWorkspaceFiles(workspace.dir, { 'node_modules/@playwright/test/package.json': `{ "version": "${version}" }\n` })
        await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
        expect(older()).toEqual([])
      }
    } finally {
      warn.mockRestore()
      await workspace.cleanup()
    }
  })

  test('says so when .gitignore ignores the whole .e2e directory, which keeps the recordings out of git', async () => {
    const workspace = await createTempWorkspace('guren-add-behaviours-ignore-')
    const warn = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
    try {
      await seedInertiaApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'package.json': INERTIA_MANIFEST, '.gitignore': 'node_modules\n.e2e/\n' })
      await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('ignores the whole directory'))).toHaveLength(1)

      warn.mockClear()
      await writeWorkspaceFiles(workspace.dir, { '.gitignore': 'node_modules\n.e2e/*\n!.e2e/cache/\n' })
      await addBrowserTests({ install: false, behaviours: true, agent: 'claude-code', loadMap: async () => mapOf([POSTS]) })
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('ignores the whole directory'))).toEqual([])
    } finally {
      warn.mockRestore()
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
