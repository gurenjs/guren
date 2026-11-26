import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkNavigation } from '../src/navigation-check'
import { readNavigationFile } from '../src/navigation-file'
import { ParseCache, parseSourceFile } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const HEAD = `import { defineNavigation } from '@guren/core'
import { Job } from '../app/Models/Job'
import * as Models from '@/app/Models'
import { t } from '@/lang'
`

function read(body: string) {
  const ast = parseSourceFile(HEAD + body, '/app/config/navigation.ts')
  if (!ast) throw new Error('fixture does not parse')
  return readNavigationFile(ast, { cwd: '/app', file: '/app/config/navigation.ts' })
}

describe('readNavigationFile', () => {
  test('reads each entry with its conditions and the file its can model is imported from', () => {
    expect(read(`export default defineNavigation([
  { label: 'Jobs', route: 'jobs.index', show: { auth: 'required', where: { role: 'admin', level: -1, active: true, team: null }, can: ['create', Job] } },
])`)).toEqual({
      status: 'read',
      entries: [{
        label: 'Jobs',
        route: 'jobs.index',
        line: 6,
        auth: 'required',
        where: { role: 'admin', level: -1, active: true, team: null },
        can: { ability: 'create', model: { expression: 'Job', className: 'Job', module: '/app/app/Models/Job' } },
      }],
    })
  })

  test('follows a const list and a const definition through as const and satisfies', () => {
    expect(read("const entries = [{ label: `Jobs`, route: 'jobs.index' }] as const\nexport default defineNavigation(entries)"))
      .toEqual({ status: 'read', entries: [{ label: 'Jobs', route: 'jobs.index', line: 5 }] })
    expect(read("const nav = defineNavigation([{ label: 'A', route: 'a', show: { can: ['viewAny', Models.Job] } }]) satisfies unknown\nexport default nav"))
      .toEqual({ status: 'read', entries: [{ label: 'A', route: 'a', line: 5, can: { ability: 'viewAny', model: { expression: 'Models.Job', className: 'Job', module: '/app/app/Models' } } }] })
  })

  test.each([
    ['a spread list', "const more = [{ label: 'B', route: 'b' }]\nexport default defineNavigation([{ label: 'A', route: 'a' }, ...more])", 'the list spreads another list'],
    ['a translated label', "export default defineNavigation([{ label: t('nav.jobs'), route: 'jobs.index' }])", 'a label is not a string written in place'],
    ['a key the runtime does not take', "export default defineNavigation([{ label: 'A', route: 'a', icon: 'x' }])", 'an entry has "icon", which defineNavigation() does not take'],
    ['an auth value the runtime refuses', "export default defineNavigation([{ label: 'A', route: 'a', show: { auth: 'admin' } }])", 'show.auth is "admin"; it takes any, required or guest'],
    ['a route named twice', "export default defineNavigation([{ label: 'A', route: 'a' }, { label: 'B', route: 'a' }])", 'route "a" is named twice, which defineNavigation() refuses'],
    ['a where value held in a name', "const role = 'admin'\nexport default defineNavigation([{ label: 'A', route: 'a', show: { where: { role } } }])", 'show.where.role is not a string, number, boolean or null written in place'],
    ['a can model that is no class name', "export default defineNavigation([{ label: 'A', route: 'a', show: { can: ['create', models()] } }])", 'the model show.can names is not a class name'],
  ])('refuses %s with the reason and the line', (_name, body, reason) => {
    expect(read(body)).toMatchObject({ status: 'unreadable', reason, line: expect.any(Number) })
  })

  test('reads a file that defines no navigation as no definition, a name in a comment included', () => {
    expect(read('export default { entries: [] }')).toEqual({ status: 'not-a-definition' })
    expect(read('// export default defineNavigation([])\nexport default 1')).toEqual({ status: 'not-a-definition' })
  })
})

const AUTH = [{ kind: 'alias', name: 'auth', capabilities: { authentication: { mode: 'required' } } }]

function controller(name: string, action: string) {
  return { name, action, file: `app/Http/Controllers/${name}.ts`, exportName: name, resolved: 'identity' }
}

function route(method: string, path: string, name: string, target?: ReturnType<typeof controller>, middleware: object[] = []) {
  return { method, path, name, ...(target ? { controller: target } : {}), middleware, module: null, schemas: {} }
}

const ROUTES = [
  route('GET', '/jobs', 'jobs.index', controller('JobController', 'index')),
  route('GET', '/jobs/create', 'jobs.create', controller('JobController', 'create'), AUTH),
  route('GET', '/dashboard', 'dashboard', controller('PageController', 'dashboard'), AUTH),
  route('GET', '/admin', 'admin.index', controller('JobController', 'admin'), AUTH),
  route('GET', '/settings', 'settings', controller('PageController', 'settings'), AUTH),
  route('POST', '/jobs/export', 'jobs.export', controller('JobController', 'index')),
  route('GET', '/jobs/:id', 'jobs.show', controller('JobController', 'index')),
  route('GET', '/bye', 'logout.page', controller('PageController', 'bye')),
  route('GET', '/jobs/edit', 'jobs.edit-all', controller('JobController', 'editAll'), AUTH),
  route('GET', '/reports', 'reports.index', controller('PageController', 'reports')),
  route('GET', '/jobs/archive', 'jobs.archive', controller('JobController', 'archive')),
  route('GET', '/billing', 'billing.portal', undefined, AUTH),
  route('GET', '/jobs/drafts', 'jobs.drafts', controller('JobController', 'drafts'), AUTH),
]

const NAVIGATION = `import { defineNavigation } from '@guren/core'
import { Job } from '@/app/Models/Job'
import { Report } from '@/app/Models/Report'

export default defineNavigation([
  { label: 'Jobs', route: 'jobs.index' },
  { label: 'Post a job', route: 'jobs.create', show: { can: ['create', Job] } },
  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
  { label: 'Admin', route: 'admin.index', show: { where: { role: 'admin' } } },
  { label: 'Settings', route: 'settings' },
  { label: 'Export', route: 'jobs.export' },
  { label: 'Job', route: 'jobs.show' },
  { label: 'Missing', route: 'missing.route' },
  { label: 'Bye', route: 'logout.page' },
  { label: 'Edit all', route: 'jobs.edit-all', show: { auth: 'required', can: ['update', Job] } },
  { label: 'Reports', route: 'reports.index', show: { can: ['view', Report] } },
  { label: 'Archive', route: 'jobs.archive', show: { can: ['viewAny', Job] } },
  { label: 'Billing', route: 'billing.portal', show: { auth: 'required' } },
  { label: 'Drafts', route: 'jobs.drafts', show: { auth: 'required' } },
])
`

const APP = {
  'config/navigation.ts': NAVIGATION,
  'app/Models/Job.ts': 'export class Job {}\n',
  'app/Models/Report.ts': 'export class Report {}\n',
  'app/Policies/JobPolicy.ts': `import { Policy } from '@guren/core'
export class JobPolicy extends Policy {
  viewAny(user: unknown) { return user !== null }
  create(user: unknown) { return user !== null }
  update(user: unknown, job: unknown) { return Boolean(user && job) }
}
`,
  'app/Http/Controllers/JobController.ts': `import { Controller } from '@guren/core'
import { Job } from '@/app/Models/Job'
import { pages } from '@/.guren/pages.gen'
export class JobController extends Controller {
  async index() { return this.inertia(pages.jobs.Index, {}) }
  async create() { await this.authorize('create', Job); return this.inertia(pages.jobs.Create, {}) }
  async admin() { await this.authorize('viewAny', Job); return this.inertia(pages.jobs.Admin, {}) }
  async editAll() { await this.authorize('update', Job); return this.inertia(pages.jobs.EditAll, {}) }
  async archive() { await this.authorize('create', Job); return this.inertia(pages.jobs.Archive, {}) }
  async drafts() { return this.renderList() }
  async renderList() { return this.inertia(pages.jobs.Index, {}) }
}
`,
  'app/Http/Controllers/PageController.ts': `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
export class PageController extends Controller {
  async dashboard() { return this.inertia(pages.Dashboard, {}) }
  async settings() { return this.inertia(pages.Settings, {}) }
  async bye() { return this.redirect('/') }
  async reports() { return this.inertia(pages.Reports, {}) }
}
`,
}

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-navigation-check-')
})

afterEach(async () => {
  await workspace.cleanup()
})

function manifestOf(routes: object[]) {
  return { routes, warnings: [], providers: [], entry: { file: 'src/app.ts' } }
}

async function run(files: Record<string, string>, options: { routes?: object[]; definitions?: object[] } = {}) {
  await writeWorkspaceFiles(workspace.dir, files)
  const introspect = options.routes ? async () => ({ status: 'ok', manifest: manifestOf(options.routes!) }) : undefined
  const results = await checkNavigation({
    cwd: workspace.dir,
    cache: new ParseCache(),
    routesFile: 'routes/web.ts',
    ...(introspect ? { introspect: introspect as never } : {}),
    ...(options.definitions ? { definitions: options.definitions as never } : {}),
  })
  expect(results.every((result) => result.advisory)).toBe(true)
  return results
}

const verdicts = (results: Awaited<ReturnType<typeof run>>) => results.map((result) => [result.key, result.status])

describe('checkNavigation', () => {
  test('reads nothing in an app with no config/navigation.ts', async () => {
    expect(await run({ 'app/Models/Job.ts': 'export class Job {}\n' }, { routes: ROUTES })).toEqual([])
  })

  test('judges each entry against the introspected app, one finding per reading', async () => {
    expect(verdicts(await run(APP, { routes: ROUTES }))).toEqual([
      ['navigation:jobs.index', 'pass'],
      ['navigation:jobs.create', 'pass'],
      ['navigation:dashboard', 'pass'],
      ['navigation-ability:admin.index', 'warn'],
      ['navigation-sign-in:settings', 'warn'],
      ['navigation-route:jobs.export', 'warn'],
      ['navigation-route:jobs.show', 'warn'],
      ['navigation-route:missing.route', 'warn'],
      ['navigation-page:logout.page', 'warn'],
      ['navigation-can:jobs.edit-all', 'warn'],
      ['navigation-can:reports.index', 'warn'],
      ['navigation-ability:jobs.archive', 'warn'],
      ['navigation-action:billing.portal', 'warn'],
      ['navigation-action:jobs.drafts', 'warn'],
    ])
  })

  test('says why each reading warns', async () => {
    const byKey = new Map((await run(APP, { routes: ROUTES })).map((result) => [result.key, result.message]))

    expect(byKey.get('navigation-ability:admin.index')).toContain("authorizes 'viewAny' on Job, and the entry does not ask it")
    expect(byKey.get('navigation-ability:admin.index')).toContain('Its where condition may restate')
    expect(byKey.get('navigation-ability:jobs.archive')).toContain("The entry asks 'viewAny' on Job, and the action of route \"jobs.archive\"")
    expect(byKey.get('navigation-sign-in:settings')).toBe('The entry is shown to everyone, and route "settings" requires sign-in, so a guest follows the link to the sign-in page.')
    expect(byKey.get('navigation-can:jobs.edit-all')).toContain('JobPolicy.update requires a second parameter')
    expect(byKey.get('navigation-can:reports.index')).toContain('No app/Policies/ReportPolicy.ts pairs with Report')
    expect(byKey.get('navigation-page:logout.page')).toContain('makes no this.inertia() call')
    expect(byKey.get('navigation-action:jobs.drafts')).toContain('its action calls this.renderList(), which is not read')
    expect(byKey.get('navigation-action:billing.portal')).toContain('its handler is inline')
  })

  test('reports a provider route the manifest lacks as missing, and the same name absent from the routes file as unverified', async () => {
    const withoutPortal = ROUTES.filter((entry) => entry.name !== 'billing.portal')
    const missing = (await run(APP, { routes: withoutPortal })).find((result) => result.key === 'navigation-route:billing.portal')
    expect(missing).toMatchObject({ status: 'warn', message: 'Route "billing.portal" is not registered, so the runtime hides the entry.' })
    expect(missing?.evidence).toBeUndefined()

    const definitions = withoutPortal.map(({ middleware: _middleware, module: _module, schemas: _schemas, controller: target, ...rest }) =>
      ({ ...rest, ...(target ? { controller: { name: target.name, action: target.action } } : {}) }))
    const results = await run(APP, { definitions })
    expect(results.find((result) => result.key === 'navigation-route:billing.portal')).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(results.find((result) => result.key === 'navigation-sign-in:settings')).toBeUndefined()
    expect(results.find((result) => result.key === 'navigation-sign-in-unverified')?.message)
      .toStartWith('Whether the routes of "jobs.index", "settings", "logout.page" require sign-in is unverified')
  })

  test('leaves a name two routes share unchecked, since the order .name() ran in is not read', async () => {
    const results = await run(APP, { routes: [...ROUTES, route('GET', '/jobs/all', 'jobs.index', controller('JobController', 'index'))] })
    expect(results.find((result) => result.key === 'navigation-route:jobs.index')?.message).toStartWith('2 routes are named "jobs.index"')
  })

  test('reads a can model imported through a barrel as unverified, not as a model with no policy', async () => {
    const navigation = `import { defineNavigation } from '@guren/core'
import * as Models from '@/app/Models'
export default defineNavigation([{ label: 'Post a job', route: 'jobs.create', show: { can: ['create', Models.Job] } }])
`
    const results = await run({ ...APP, 'config/navigation.ts': navigation }, { routes: ROUTES })
    expect(verdicts(results)).toEqual([['navigation-can:jobs.create', 'warn']])
    expect(results[0]!.message).toContain('is imported from app/Models, not from the model\'s own file')
  })

  test('reports an optional second parameter as unverified and a definePolicy() ability its class lacks as never asked', async () => {
    const optional = `import { Policy } from '@guren/core'
export class JobPolicy extends Policy {
  create(user: unknown, team?: unknown) { return user !== null && team === undefined }
}
`
    const results = await run({ ...APP, 'app/Policies/JobPolicy.ts': optional }, { routes: ROUTES })
    expect(results.find((result) => result.key === 'navigation-can:jobs.create')?.message).toContain('takes a second parameter it may go without')

    const defined = `import { definePolicy } from '@guren/core'
export const JobPolicy = definePolicy({ publish: (user: unknown) => user !== null })
`
    const navigation = NAVIGATION.replace("show: { can: ['create', Job] }", "show: { can: ['publish', Job] }")
    const definedResults = await run({ ...APP, 'config/navigation.ts': navigation, 'app/Policies/JobPolicy.ts': defined }, { routes: ROUTES })
    expect(definedResults.find((result) => result.key === 'navigation-can:jobs.create')?.message).toContain("whose class has no 'publish'")
  })

  test('warns once on a file it cannot read and checks no entry', async () => {
    const results = await run({ ...APP, 'config/navigation.ts': NAVIGATION.replace("label: 'Jobs'", "label: t('jobs')") }, { routes: ROUTES })
    expect(verdicts(results)).toEqual([['navigation-file', 'warn']])
    expect(results[0]!.message).toBe('config/navigation.ts is not read (line 6): a label is not a string written in place. The navigation checks did not run.')
  })
})
