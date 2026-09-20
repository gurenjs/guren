import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PlanAppDetail, PlanAppRouteDetail } from '../src/plan/app-detail'
import { loadPlanAppState } from '../src/plan/app-state'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// Earlier runs' roots are removed at the start, one directory per application: see plan-status-command.test.ts.
const ROOT_PREFIX = 'guren-plan-app-detail-'
let ROOT: string

const CONTROLLER = `import { Controller } from '@guren/core'
import { OrphanPayloadSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

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
    const stale = (await readdir(tmpdir())).filter((name) => name.startsWith(ROOT_PREFIX))
    await Promise.all(stale.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })))
    ROOT = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
  })

  test('should leave the detail out unless asked, so plan:render imports no schema', async () => {
    const dir = join(ROOT, 'plain')
    await writeWorkspaceFiles(dir, { 'app/Http/Controllers/PostController.ts': CONTROLLER })

    expect((await loadPlanAppState(dir)).detail).toBeUndefined()
  })

  test('should call the entry registrar and a listed module mounted', async () => {
    const detail = await detailOf('mounted', { 'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }') })

    expect(detail.mounts).toEqual({ entry: 'mounted', modules: { billing: 'mounted' } })
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
      { key: 'PostController.update', validates: ['PostPayloadSchema', 'OrphanPayloadSchema'] },
      { key: 'PostController.destroy', pages: [], calls: ['authorize', 'redirect'], abilities: ['delete'], validates: [] },
    ])
  })

  test('should name validators by exported symbol and keep the files that yielded no model', async () => {
    const detail = await detailOf('names', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.validators).toEqual([
      { name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null },
      { name: 'OrphanPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null },
      { name: 'helper', file: 'app/Http/Validators/PostValidator.ts', module: null },
    ])
    expect(detail.unparsedModelFiles).toEqual(['app/Models/Broken.ts'])
  })

  test('should report the app root every discovered element came from', async () => {
    const detail = await detailOf('roots', { ...BILLING_FILES, 'src/app.ts': entry('{ routes: registerWebRoutes, modules: [billing] }') })

    expect(detail.models).toContainEqual(expect.objectContaining({ className: 'Invoice', module: 'billing' }))
    expect(detail.controllers).toEqual([
      { className: 'PostController', module: null },
      { className: 'InvoiceController', module: 'billing' },
    ])
    expect(detail.actions).toContainEqual(expect.objectContaining({ key: 'InvoiceController.index', module: 'billing' }))
    expect(detail.validators).toContainEqual({ name: 'InvoicePayloadSchema', file: 'modules/billing/app/Http/Validators/InvoiceValidator.ts', module: 'billing' })
    expect(detail.resources).toEqual([{ className: 'InvoiceResource', module: 'billing' }])
    expect(detail.policies).toEqual([{ className: 'InvoicePolicy', module: 'billing' }])
    expect(detail.sideEffects.job).toEqual([{ className: 'ChargeInvoice', module: 'billing' }])
  })

  test('should leave a barrel out, so a re-export does not enter a symbol under the forwarding file’s app root', async () => {
    const detail = await detailOf('reexport', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/index.ts': "export * from './PostValidator.js'\n",
      'modules/billing/app/Http/Validators/InvoiceValidator.ts': 'export const InvoicePayloadSchema = {}\n',
      'app/Http/Validators/Forwarded.ts': "export { InvoicePayloadSchema } from '../../../modules/billing/app/Http/Validators/InvoiceValidator.js'\n",
    })

    expect(detail.validators).toEqual([
      { name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null },
      { name: 'OrphanPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null },
      { name: 'helper', file: 'app/Http/Validators/PostValidator.ts', module: null },
      { name: 'InvoicePayloadSchema', file: 'modules/billing/app/Http/Validators/InvoiceValidator.ts', module: 'billing' },
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
    })
    expect(detail.validators).toContainEqual({ name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null })
  })

  test('should report the validators unreadable when a file outside a barrel re-exports everything', async () => {
    const detail = await detailOf('starexport', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/All.ts': "export * from './PostValidator.js'\n",
    })

    expect(detail.validators).toEqual({ unreadable: expect.stringContaining('app/Http/Validators/All.ts') })
  })
})
