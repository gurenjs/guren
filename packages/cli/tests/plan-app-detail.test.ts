import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PlanAppDetail } from '../src/plan/app-detail'
import { loadPlanAppState } from '../src/plan/app-state'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// Fixed and cleaned at the start, one directory per application: see plan-status-command.test.ts.
const ROOT = join(tmpdir(), 'guren-plan-app-detail')

const CONTROLLER = `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {
    // this.inertia('posts/Commented', {})
    return this.inertia('posts/Index', { posts: [] })
  }
  async destroy() {
    await this.authorize('delete', null)
    return this.redirect('/posts')
  }
}
`

const WEB_ROUTES = `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { registerAdminRoutes } from './admin.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
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
  'app/Http/Validators/PostValidator.ts': 'export const PostPayloadSchema = 1\nexport function helper() {}\nconst hidden = 2\nvoid hidden\n',
  'app/Models/Broken.ts': 'export const notAModel = 1\n',
  ...BILLING_MODULE,
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
    await rm(ROOT, { recursive: true, force: true })
    await mkdir(ROOT, { recursive: true })
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

  test('should mark a routes file reached only when the entry calls its registrar', async () => {
    const detail = await detailOf('reached', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    const reached = Object.fromEntries(detail.routeFiles.map((file) => [file.file, file.reached]))
    expect(reached).toMatchObject({ 'routes/web.ts': true, 'routes/admin.ts': true, 'routes/orphan.ts': false })
    expect(detail.routeFiles.find((file) => file.file === 'routes/orphan.ts')!.identifiers).toContain('OrphanSchema')
  })

  test('should read an action body without its comments', async () => {
    const detail = await detailOf('actions', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.actions).toMatchObject([
      { key: 'PostController.index', pages: ['posts/Index'], calls: ['inertia'], abilities: [] },
      { key: 'PostController.destroy', pages: [], calls: ['authorize', 'redirect'], abilities: ['delete'] },
    ])
  })

  test('should name validators by exported symbol and keep the files that yielded no model', async () => {
    const detail = await detailOf('names', { 'src/app.ts': entry('{ routes: registerWebRoutes }') })

    expect(detail.validators).toEqual([
      { name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts' },
      { name: 'helper', file: 'app/Http/Validators/PostValidator.ts' },
    ])
    expect(detail.unparsedModelFiles).toEqual(['app/Models/Broken.ts'])
  })

  test('should report the validators unreadable when a file re-exports names it does not declare', async () => {
    const detail = await detailOf('reexport', {
      'src/app.ts': entry('{ routes: registerWebRoutes }'),
      'app/Http/Validators/index.ts': "export * from './PostValidator.js'\n",
    })

    expect(detail.validators).toEqual({ unreadable: expect.stringContaining('app/Http/Validators/index.ts') })
  })
})
