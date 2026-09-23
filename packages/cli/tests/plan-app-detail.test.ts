import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { PlanAppDetail, PlanAppRouteDetail } from '../src/plan/app-detail'
import { loadPlanAppState } from '../src/plan/app-state'
import { createTempRoot, linkWorkspaceCore, PAGE_COMPONENT_FIXTURE, writeWorkspaceFiles } from './helpers'

// One directory per application: see plan-status-command.test.ts.
const ROOT_PREFIX = 'guren-plan-app-detail-'
let ROOT: string

/** The fixture's validators are plain objects, so their fields are read as unreadable. */
const NOT_ZOD = { unreadable: expect.stringContaining('is not a zod schema') }

const CONTROLLER = `import { Controller } from '@guren/core'
import { OrphanPayloadSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

const schemas = { post: PostPayloadSchema }

export class PostController extends Controller {
  async index() {
    // this.inertia('posts/Commented', {})
    return this.inertia('posts/Index', { posts: [] })
  }
  async store() {
    await this.validateBody(PostPayloadSchema)
    return this.redirect('/posts')
  }
  async update() {
    await this.validateBodySafe(PostPayloadSchema)
    this.validateQuery<{ page: number }>(OrphanPayloadSchema)
    this.validateParams(schemas . post)
    return this.redirect('/posts')
  }
  async destroy() {
    await this.authorize('delete', null)
    return this.redirect('/posts')
  }
}
`

/**
 * `OrphanPayloadSchema` is named by four shapes that register nothing: an object that is
 * no route contract at all, one nobody passes, a function nobody calls, and a branch
 * nobody reaches. Each carries a `body` key, and none of them wires anything.
 */
const WEB_ROUTES = `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { OrphanPayloadSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { registerAdminRoutes } from './admin.js'

export const mailDefaults = { subject: 'hi', body: OrphanPayloadSchema }
const unusedOptions = { name: 'posts.unused', body: OrphanPayloadSchema }

function registerUncalledRoutes(router: Router): void {
  router.post('/uncalled', { name: 'posts.uncalled', body: OrphanPayloadSchema }, [PostController, 'store'])
}

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  if (Number('0') === 1) {
    router.post('/never', { name: 'posts.never', body: OrphanPayloadSchema }, [PostController, 'store'])
  }
  void unusedOptions
  void registerUncalledRoutes
  registerAdminRoutes(router)
}
`

const ROUTE_FILE = (name: string, symbol: string): string => `import type { Router } from '@guren/core'

const ${symbol} = null

export function ${name}(router: Router): void {
  void router
  void ${symbol}
}
`

const BILLING_MODULE = {
  'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes.js'

export default defineModule({ name: 'billing', providers: [], routes: registerBillingRoutes })
`,
  'modules/billing/routes.ts': `import type { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/invoices', (c) => c.text('ok')).name('invoices.index')
}
`,
}

const FILES: Record<string, string> = {
  'app/Http/Controllers/PostController.ts': CONTROLLER,
  'routes/web.ts': WEB_ROUTES,
  'routes/admin.ts': ROUTE_FILE('registerAdminRoutes', 'AdminSchema'),
  'routes/orphan.ts': ROUTE_FILE('registerOrphanRoutes', 'OrphanSchema'),
  // Both schemas are objects, so identity is what separates them, not their shape.
  'app/Http/Validators/PostValidator.ts':
    'export const PostPayloadSchema = { safeParse: () => ({ success: true, data: {} }) }\nexport const OrphanPayloadSchema = { safeParse: () => ({ success: true, data: {} }) }\nexport function helper() {}\nconst hidden = 3\nvoid hidden\n',
  'app/Models/Broken.ts': 'export const notAModel = 1\n',
  ...BILLING_MODULE,
}

/** The same kinds of file inside a module, for the app root each detail entry reports. */
const BILLING_FILES: Record<string, string> = {
  'modules/billing/app/Models/Invoice.ts': "import { defineModel } from '@guren/core'\nimport { invoices } from '../../db/schema'\n\nexport class Invoice extends defineModel(invoices) {}\n",
  'modules/billing/app/Http/Controllers/InvoiceController.ts': "import { Controller } from '@guren/core'\n\nexport class InvoiceController extends Controller {\n  async index() {}\n}\n",
  'modules/billing/app/Http/Validators/InvoiceValidator.ts': 'export const InvoicePayloadSchema = 1\n',
  'modules/billing/app/Http/Resources/InvoiceResource.ts': 'export class InvoiceResource {}\n',
  'modules/billing/app/Policies/InvoicePolicy.ts': 'export class InvoicePolicy {}\n',
  'modules/billing/app/Jobs/ChargeInvoice.ts': 'export class ChargeInvoice {}\n',
}

function entry(options: string, imports = "import { registerWebRoutes } from '../routes/web.js'\nimport billing from '../modules/billing/index.js'\n"): string {
  return `import { createApp } from '@guren/core'\n${imports}\nexport default createApp(${options})\n`
}

async function detailOf(name: string, files: Record<string, string>): Promise<PlanAppDetail> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, { ...FILES, ...files, 'bunfig.toml': '[install]\nauto = "disable"\n' })
  await linkWorkspaceCore(dir)
  const state = await loadPlanAppState(dir, { detail: true })
  if (!state.detail) throw new Error('the loader returned no detail')
  return state.detail
}

describe('loadPlanAppState({ detail: true })', () => {
  beforeAll(async () => {
    ROOT = await createTempRoot(ROOT_PREFIX)
  })

  test('should leave the detail out unless asked, so plan:render imports no schema', async () => {
    const dir = join(ROOT, 'plain')
    await writeWorkspaceFiles(dir, { 'app/Http/Controllers/PostController.ts': CONTROLLER })

    expect((await loadPlanAppState(dir)).detail).toBeUndefined()
  })

  test('should call the entry registrar and a listed module mounted', async () => {
    const detail = await detailOf('mounted', { 'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }') })

    expect(detail.mounts).toEqual({
      entry: 'mounted',
      modules: { billing: 'mounted' },
      files: { entry: ['src/app.ts'], modules: { billing: ['src/app.ts', 'modules/billing/index.ts'] } },
    })
    expect(detail.routes).toMatchObject([
      { name: 'posts.index', action: 'PostController.index', module: null },
      { name: 'posts.store', action: 'PostController.store', module: null },
      { name: 'invoices.index', module: 'billing' },
    ])
  })

  test('should not call a module mounted that the directory scan found and createApp() does not list', async () => {
    const detail = await detailOf('unlisted', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.mounts.entry).toBe('mounted')
    expect(detail.mounts.modules.billing).toEqual({ unconfirmed: expect.stringContaining('lists no modules') })
  })

  test('should leave a module unconfirmed when createApp({ modules }) is not an array literal', async () => {
    const detail = await detailOf('modules-not-array', {
      'src/app.ts': entry('{ routes: registerWebRoutes, modules: allModules }', "import { registerWebRoutes } from '../routes/web.js'\nimport { allModules } from '../modules/all.js'\n"),
    })

    expect(detail.mounts.modules.billing).toEqual({ unconfirmed: expect.stringContaining('is not an array literal') })
  })

  test('should leave a module unconfirmed when createApp({ modules }) holds an entry it cannot trace', async () => {
    const detail = await detailOf('modules-untraceable', {
      'src/app.ts': entry('{ routes: registerWebRoutes, modules: [inline] }', "import { registerWebRoutes } from '../routes/web.js'\nconst inline = { name: 'inline', providers: [], commands: [] }\n"),
    })

    expect(detail.mounts.modules.billing).toEqual({ unconfirmed: expect.stringContaining('cannot trace to a file') })
  })

  test('should name a computed key, not a spread, when createApp() may carry routes behind one', async () => {
    const detail = await detailOf('entry-computed-key', {
      'src/app.ts': entry('{ [key]: registerWebRoutes }', "import { registerWebRoutes } from '../routes/web.js'\nconst key = 'routes'\n"),
    })

    expect(detail.mounts.entry).toEqual({ unconfirmed: expect.stringContaining('spreads its options or computes a key') })
  })

  test('should not read a routes method on createApp() as passing no routes', async () => {
    const detail = await detailOf('entry-routes-method', {
      'src/app.ts': entry('{ routes(router) { registerWebRoutes(router) } }', "import { registerWebRoutes } from '../routes/web.js'\n"),
    })

    expect(detail.mounts.entry).toEqual({ unconfirmed: expect.stringContaining('is not a registrar imported from a file') })
  })

  test('should not call the entry mounted when createApp() takes a registrar from another file', async () => {
    const detail = await detailOf('other-file', {
      'src/app.ts': entry('{ routes: registerAdminRoutes }', "import { registerAdminRoutes } from '../routes/admin.js'\n"),
    })

    expect(detail.mounts.entry).toEqual({ unconfirmed: expect.stringContaining('routes/admin') })
  })

  test('should not call the entry mounted when createApp() takes an export the loader would not pick', async () => {
    const detail = await detailOf('other-export', {
      'routes/web.ts': `${WEB_ROUTES}\nexport function registerRoutes(): void {}\n`,
      'src/app.ts': entry('{ routes: registerWebRoutes }', "import { registerWebRoutes } from '../routes/web.js'\n"),
    })

    expect(detail.mounts.entry).toEqual({ unconfirmed: expect.stringContaining('"registerRoutes"') })
  })

  test('should not call anything mounted when the options are not a literal', async () => {
    const detail = await detailOf('opaque', { 'src/app.ts': entry('options', "const options = {}\n") })

    expect(detail.mounts.entry).toEqual({ unconfirmed: expect.stringContaining('object literal') })
  })

  test('should read every routes file of the application, a module’s single-file entry included', async () => {
    const detail = await detailOf('routefiles', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    // `modules/billing/routes.ts` is what `make:module` scaffolds, and no `routes/` directory scan reaches it.
    expect(detail.routeFiles.map((file) => file.file).sort()).toEqual(['modules/billing/routes.ts', 'routes/admin.ts', 'routes/orphan.ts', 'routes/web.ts'])

    const web = detail.routeFiles.find((file) => file.file === 'routes/web.ts')!
    expect(web.identifiers).toContain('PostPayloadSchema')
  })

  test('should read a contract schema only off a route the registrar actually registered', async () => {
    const detail = await detailOf('contracts', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    const contracts = Object.fromEntries((detail.routes as PlanAppRouteDetail[]).map((route) => [route.name, route.contractSchemas]))
    expect(contracts).toEqual({ 'posts.index': [], 'posts.store': ['PostPayloadSchema'], 'invoices.index': [] })
  })

  test('should read an action body without its comments, and the schemas it validates with', async () => {
    const detail = await detailOf('actions', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.actions).toMatchObject([
      { key: 'PostController.index', pages: ['posts/Index'], calls: ['inertia'], abilities: [], validates: [] },
      { key: 'PostController.store', calls: ['validateBody', 'redirect'], validates: ['PostPayloadSchema'] },
      // The `Safe` variants and the generic form are validation too, and every one of the
      // six helpers is declared generic in `Controller.ts`.
      { key: 'PostController.update', validates: ['PostPayloadSchema', 'OrphanPayloadSchema', 'schemas.post'] },
      { key: 'PostController.destroy', pages: [], calls: ['authorize', 'redirect'], abilities: ['delete'], validates: [] },
    ])
  })

  test('should name validators by exported symbol and keep the files that yielded no model', async () => {
    const detail = await detailOf('names', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.validators).toEqual([
      { name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
      { name: 'OrphanPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
      { name: 'helper', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
    ])
    expect(detail.unparsedModelFiles).toEqual(['app/Models/Broken.ts'])
  })

  test('should report the app root every discovered element came from', async () => {
    const detail = await detailOf('roots', { ...BILLING_FILES, 'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }') })

    expect(detail.models).toContainEqual(expect.objectContaining({ className: 'Invoice', module: 'billing' }))
    expect(detail.controllers).toEqual([
      { className: 'PostController', module: null, file: 'app/Http/Controllers/PostController.ts' },
      { className: 'InvoiceController', module: 'billing', file: 'modules/billing/app/Http/Controllers/InvoiceController.ts' },
    ])
    expect(detail.actions).toContainEqual(expect.objectContaining({ key: 'InvoiceController.index', module: 'billing' }))
    expect(detail.validators).toContainEqual({ name: 'InvoicePayloadSchema', file: 'modules/billing/app/Http/Validators/InvoiceValidator.ts', module: 'billing', fields: NOT_ZOD })
    expect(detail.resources).toEqual([{ className: 'InvoiceResource', module: 'billing', file: 'modules/billing/app/Http/Resources/InvoiceResource.ts' }])
    expect(detail.policies).toEqual([
      { className: 'InvoicePolicy', module: 'billing', file: 'modules/billing/app/Policies/InvoicePolicy.ts', abilities: { declared: [], fields: [] } },
    ])
    expect(detail.sideEffects.job).toEqual([{ className: 'ChargeInvoice', module: 'billing', file: 'modules/billing/app/Jobs/ChargeInvoice.ts', usedIn: [], unprovenIn: [], mentionedIn: [] }])
  })

  test('should leave a barrel out, so a re-export does not enter a symbol under the forwarding file’s app root', async () => {
    const detail = await detailOf('reexport', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/index.ts': "export * from './PostValidator.js'\n",
      'modules/billing/app/Http/Validators/InvoiceValidator.ts': 'export const InvoicePayloadSchema = {}\n',
      'app/Http/Validators/Forwarded.ts': "export { InvoicePayloadSchema } from '../../../modules/billing/app/Http/Validators/InvoiceValidator.js'\n",
    })

    expect(detail.validators).toEqual([
      { name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
      { name: 'OrphanPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
      { name: 'helper', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD },
      { name: 'InvoicePayloadSchema', file: 'modules/billing/app/Http/Validators/InvoiceValidator.ts', module: 'billing', fields: NOT_ZOD },
    ])
  })

  test('should leave a validator file that throws on import unmatchable rather than the section unreadable', async () => {
    const detail = await detailOf('throwing-validator', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/Throws.ts': "export const ThrowsSchema = {}\nthrow new Error('boom')\n",
    })

    expect(detail.validators).toContainEqual({
      name: 'ThrowsSchema',
      file: 'app/Http/Validators/Throws.ts',
      module: null,
      unimported: expect.stringContaining('boom'),
      fields: { unreadable: expect.stringContaining('would not import') },
    })
    expect(detail.validators).toContainEqual({ name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, fields: NOT_ZOD })
  })

  test('should carry the component file of a renderable page and skip a .ts sibling', async () => {
    const detail = await detailOf('pages', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'resources/js/pages/posts/Index.tsx': PAGE_COMPONENT_FIXTURE,
      'resources/js/pages/posts/Legacy.jsx': PAGE_COMPONENT_FIXTURE,
      // Neither the client glob nor pages.gen.ts registers these, so they are not pages.
      'resources/js/pages/posts/Helpers.ts': 'export const columns = []\n',
      'resources/js/pages/posts/Script.js': 'export const noop = () => {}\n',
    })

    expect(detail.pages).toEqual([
      { id: 'posts/Index', file: 'resources/js/pages/posts/Index.tsx', props: expect.anything() },
      { id: 'posts/Legacy', file: 'resources/js/pages/posts/Legacy.jsx', props: expect.anything() },
    ])
  })

  test('should report the validators unreadable when a file outside a barrel re-exports everything', async () => {
    const detail = await detailOf('starexport', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/All.ts': "export * from './PostValidator.js'\n",
    })

    expect(detail.validators).toEqual({ unreadable: expect.stringContaining('app/Http/Validators/All.ts') })
  })
})

describe('loadPlanAppState({ detail: true }) on route shadowing', () => {
  const routes = (...lines: string[]): string => `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  void PostController
${lines.map((line) => `  ${line}`).join('\n')}
}
`
  const catalog = {
    'modules/catalog/index.ts': "import { defineModule } from '@guren/core'\n\nexport default defineModule({ name: 'catalog', providers: [], routes: (router) => { router.get('/invoices', (c) => c.text('ok')).name('catalog.invoices') } })\n",
  }
  const shadowedOf = (detail: PlanAppDetail): Record<string, unknown> =>
    Object.fromEntries((detail.routes as PlanAppRouteDetail[]).map((route) => [route.name, route.shadowed?.unconfirmed]))

  beforeAll(async () => {
    ROOT ??= await createTempRoot(ROOT_PREFIX)
  })

  test('should name a route registered first that answers every request of a later one', async () => {
    const detail = await detailOf('shadowed', {
      'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }'),
      'routes/web.ts': routes(
        "router.get('/comments/:id', [PostController, 'index']).name('comments.show')",
        "router.get('/comments/new', (c) => c.text('new')).name('comments.create')",
      ),
    })

    expect(shadowedOf(detail)).toEqual({
      'comments.show': undefined,
      'comments.create': 'GET /comments/new is shadowed and never reached: GET /comments/:id ("comments.show", PostController.index), registered by routes/web.ts, comes first and answers every request its path matches',
      'invoices.index': undefined,
    })
  })

  test('should leave a route alone that is registered before what would shadow it, or that another method serves', async () => {
    const detail = await detailOf('unshadowed', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'routes/web.ts': routes(
        "router.get('/comments/new', (c) => c.text('new')).name('comments.create')",
        "router.get('/comments/:id', (c) => c.text('show')).name('comments.show')",
        "router.post('/comments/:id', (c) => c.text('update')).name('comments.update')",
        "router.post('/comments/new', (c) => c.text('store')).name('comments.store')",
      ),
    })

    expect(shadowedOf(detail)).toEqual({
      'comments.create': undefined,
      'comments.show': undefined,
      'comments.update': undefined,
      'comments.store': expect.stringContaining('POST /comments/new is shadowed and never reached: POST /comments/:id ("comments.update")'),
      'invoices.index': undefined,
    })
  })

  test('should take an ALL route as every method, and call a constraint it cannot compare unjudged', async () => {
    const detail = await detailOf('unjudged', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'routes/web.ts': routes(
        "router.on('ALL', '/legacy/*', (c) => c.text('gone')).name('legacy')",
        "router.delete('/legacy/posts/:id', (c) => c.text('destroy')).name('legacy.destroy')",
        "router.get('/posts/:id{[0-9]+}', (c) => c.text('show')).name('posts.show')",
        "router.get('/posts/:slug', (c) => c.text('bySlug')).name('posts.slug')",
      ),
    })

    const shadowed = shadowedOf(detail)
    expect(shadowed['legacy.destroy']).toContain('is shadowed and never reached: ALL /legacy/* ("legacy"), registered by routes/web.ts, comes first and answers every request')
    expect(shadowed['posts.slug']).toBe('GET /posts/:slug may be shadowed by GET /posts/:id{[0-9]+} ("posts.show"), registered by routes/web.ts, which comes first: whether it answers every request this path matches could not be judged')
  })

  test('should put the entry registrar before every module, and never settle two modules against each other', async () => {
    const detail = await detailOf('modules', {
      ...catalog,
      'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }'),
      'routes/web.ts': routes("router.get('/:section', (c) => c.text('section')).name('section')", "router.get('/posts', (c) => c.text('posts')).name('posts.index')"),
    })

    const shadowed = shadowedOf(detail)
    expect(shadowed.section).toBeUndefined()
    expect(shadowed['posts.index']).toContain('GET /posts is shadowed and never reached: GET /:section ("section"), registered by routes/web.ts, comes first and answers')
    expect(shadowed['invoices.index']).toContain('registered by routes/web.ts, comes first and answers')
    expect(shadowed['catalog.invoices']).toContain('registered by routes/web.ts, comes first and answers')

    const apart = await detailOf('modules-apart', { ...catalog, 'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }'), 'routes/web.ts': routes() })
    expect(shadowedOf(apart)).toEqual({
      'invoices.index': 'GET /invoices may be shadowed by GET /invoices ("catalog.invoices"), registered by modules/catalog: two modules register in createApp({ modules }) order, which this does not read',
      'catalog.invoices': 'GET /invoices may be shadowed by GET /invoices ("invoices.index"), registered by modules/billing: two modules register in createApp({ modules }) order, which this does not read',
    })
  })

  test("should not clear a module's route while another module's routes did not load", async () => {
    const detail = await detailOf('module-missing', {
      'modules/broken/index.ts': "throw new Error('boom')\n",
      'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }'),
      'routes/web.ts': routes("router.get('/posts', (c) => c.text('posts')).name('posts.index')"),
    })

    expect(shadowedOf(detail)).toEqual({
      'posts.index': undefined,
      'invoices.index': expect.stringContaining("GET /invoices may be shadowed: a module's routes did not load"),
    })
  })
})
