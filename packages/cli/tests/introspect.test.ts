import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { AppManifest } from '@guren/core'

import { CHECK_INTROSPECT_TIMEOUT_MS, INTROSPECT_CHILD_BUDGET_MARGIN_MS, introspectApp, introspectRunner, withCapNote, type Introspection, type IntrospectionFailure } from '../src/introspect'
import { bunExecutable, runCaptured } from '../src/subprocess'
import {
  assertWorkspaceBuilt,
  CLI_BIN_PATH,
  createTempRoot,
  linkWorkspaceCore,
  runCliBinCaptured,
  SERVER_DIST_ENTRY,
  writeWorkspaceFiles,
} from './helpers'

const repoRoot = resolve(import.meta.dir, '../../..')

const APP_TS = `import { writeFileSync } from 'node:fs'
import { createApp, ServiceProvider } from '@guren/core'
import billing from '../modules/billing/index.js'
import shop from '../modules/shop/index.js'
import { registerWebRoutes } from '../routes/web.js'

class AppProvider extends ServiceProvider {
  register(): void {
    this.container.instance('app.provider', true)
  }

  boot(): void {
    writeFileSync('booted.txt', 'booted')
  }
}

const app = createApp({ routes: registerWebRoutes, providers: [AppProvider], modules: [billing, shop] })

export default app
`

const REPORT_CONTROLLER = (label: string) => `import { Controller } from '@guren/core'

export class ReportController extends Controller {
  async index() {
    return this.json({ module: '${label}' })
  }
}
`

const MODULE_INDEX = (name: string) => `import { defineModule } from '@guren/core'
import { ReportController } from './app/Http/Controllers/ReportController.js'

export default defineModule({
  name: '${name}',
  prefix: '/${name}',
  routes: (router) => {
    router.get('/reports', [ReportController, 'index']).name('${name}.reports')
  },
})
`

/** Routes only a class declared in the routes file, which no controller file exports: the full scan runs. */
const INLINE_ROUTES = `import { Controller, type Router } from '@guren/core'

class InlineController extends Controller {
  async index() {
    return this.json([])
  }
}

export function registerWebRoutes(router: Router): void {
  router.get('/inline', [InlineController, 'index']).name('inline')
}
`

/** An unrouted controller whose module scope leaves a mark when it is imported. */
const SIDE_EFFECT_CONTROLLER = "import { writeFileSync } from 'node:fs'\nwriteFileSync('side-effect.txt', 'ran')\n"

/** An app root that installs nothing and links no workspace package. */
const BARE_APP: Record<string, string> = {
  'bunfig.toml': '[install]\nauto = "disable"\n',
  'package.json': JSON.stringify({ name: 'bare-fixture', type: 'module' }),
}

/** A stand-in `@guren/core` whose `Application` is `application`. */
const fakeCore = (application: string): Record<string, string> => ({
  ...BARE_APP,
  'node_modules/@guren/core/package.json': JSON.stringify({ name: '@guren/core', type: 'module', exports: { '.': './index.js' } }),
  'node_modules/@guren/core/index.js': application,
})

/** A provider that starts a `sleep` helper, records its pid, and then never finishes (or does, with `hang` false). */
const spawningApp = (hang: boolean): string => `import { writeFileSync } from 'node:fs'
import { createApp, ServiceProvider } from '@guren/core'

class SpawningProvider extends ServiceProvider {
  register(): Promise<void> {
    const helper = Bun.spawn(['sleep', '30'])
    writeFileSync('helper.pid', String(helper.pid))
    return ${hang ? 'new Promise(() => {})' : 'Promise.resolve()'}
  }
}

export default createApp({ providers: [SpawningProvider] })
`

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The scaffold's entry shapes, read from the templates so a change there reaches this test. */
async function templateFile(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, 'packages/create-app/templates/default', relativePath), 'utf8')
}

async function seedApp(dir: string, overrides: Record<string, string> = {}): Promise<void> {
  await linkWorkspaceCore(dir)
  await writeWorkspaceFiles(dir, {
    // Bun otherwise installs an unresolvable specifier from npm instead of failing.
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'package.json': JSON.stringify({ name: 'introspect-fixture', type: 'module' }),
    'src/main.ts': await templateFile('src/main.ts'),
    'bin/serve.ts': await templateFile('bin/serve.ts'),
    'src/app.ts': APP_TS,
    'routes/web.ts': `import type { Router } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
}
`,
    'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export default class PostController extends Controller {
  async index() {
    return this.json([])
  }
}
`,
    'modules/billing/index.ts': MODULE_INDEX('billing'),
    'modules/billing/app/Http/Controllers/ReportController.ts': REPORT_CONTROLLER('billing'),
    'modules/shop/index.ts': MODULE_INDEX('shop'),
    'modules/shop/app/Http/Controllers/ReportController.ts': REPORT_CONTROLLER('shop'),
    ...overrides,
  })
}

function expectFailure(result: Introspection, reason: IntrospectionFailure): string {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed') throw new Error('unreachable')
  expect(result.reason).toBe(reason)
  return result.message
}

let root: string
const apps: Record<string, string> = {}

async function app(name: string, overrides?: Record<string, string>): Promise<string> {
  const dir = join(root, name)
  await seedApp(dir, overrides)
  apps[name] = dir
  return dir
}

beforeAll(async () => {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  root = await createTempRoot('guren-introspect-test-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('introspectApp()', () => {
  test('returns the manifest of a scaffold-shaped app, booting nothing', async () => {
    const dir = await app('ok')

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.schemaVersion).toBe(1)
    expect(result.manifest.entry).toMatchObject({ file: 'src/main.ts', stage: 'register' })
    expect(result.manifest.providers.find((provider) => provider.name === 'AppProvider')).toMatchObject({ source: 'options.providers', register: 'ran' })
    expect(result.manifest.bindings).toContain('app.provider')
    expect(existsSync(join(dir, 'booted.txt'))).toBe(false)
  }, 30_000)

  test('resolves two same-named controllers in two modules to their own files', async () => {
    const result = await introspectApp(apps.ok ?? await app('ok'))
    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)

    const controllerOf = (name: string) => result.manifest.routes.find((route) => route.name === name)?.controller

    expect(controllerOf('billing.reports')).toEqual({
      name: 'ReportController',
      action: 'index',
      file: 'modules/billing/app/Http/Controllers/ReportController.ts',
      exportName: 'ReportController',
      resolved: 'identity',
    })
    expect(controllerOf('shop.reports')?.file).toBe('modules/shop/app/Http/Controllers/ReportController.ts')
    expect(controllerOf('posts.index')).toMatchObject({ file: 'app/Http/Controllers/PostController.ts', exportName: 'default', resolved: 'identity' })
  }, 30_000)

  test('finds a controller declared in a file not named after it', async () => {
    const dir = await app('renamed', {
      'routes/web.ts': `import type { Router } from '@guren/core'
import { InvoiceController } from '../app/Http/Controllers/billing.js'

export function registerWebRoutes(router: Router): void {
  router.get('/invoices', [InvoiceController, 'index']).name('invoices.index')
}
`,
      'app/Http/Controllers/billing.ts': `import { Controller } from '@guren/core'

export class InvoiceController extends Controller {
  async index() {
    return this.json([])
  }
}
`,
      // A barrel re-exporting it: the declaring file wins, whatever the scan order.
      'app/Http/Controllers/index.ts': "export { InvoiceController } from './billing.js'\n",
      'app/Http/Controllers/Broken.ts': "throw new Error('broken at import')\n",
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.routes.find((route) => route.name === 'invoices.index')?.controller).toMatchObject({
      file: 'app/Http/Controllers/billing.ts',
      exportName: 'InvoiceController',
      resolved: 'identity',
    })
    expect(result.manifest.warnings).toContainEqual({
      code: 'controller-import',
      message: 'app/Http/Controllers/Broken.ts could not be imported: broken at import',
    })
  }, 30_000)

  test('leaves a framework controller and an inline class name-only without scanning app files', async () => {
    const dir = await app('framework-controller', {
      'routes/web.ts': `import { AttachmentDeliveryController, Controller, type Router } from '@guren/core'

class InlineController extends Controller {
  async index() {
    return this.json([])
  }
}

export function registerWebRoutes(router: Router): void {
  router.get('/files/:id/:name', [AttachmentDeliveryController, 'show']).name('files.show')
  router.get('/inline', [InlineController, 'index']).name('inline')
}
`,
      'app/Http/Controllers/Side.ts': SIDE_EFFECT_CONTROLLER,
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    const controllerOf = (name: string) => result.manifest.routes.find((route) => route.name === name)?.controller
    expect(controllerOf('files.show')).toMatchObject({ name: 'AttachmentDeliveryController', resolved: 'name-only', file: null })
    expect(controllerOf('inline')).toMatchObject({ name: 'InlineController', resolved: 'name-only', file: null })
    // InlineController is unmatched, so the full scan runs; the framework class alone would not trigger it.
    expect(existsSync(join(dir, 'side-effect.txt'))).toBe(true)
  }, 30_000)

  test('does not import unrouted controller files when only a framework controller is unmatched', async () => {
    const dir = await app('framework-only', {
      'routes/web.ts': `import { AttachmentDeliveryController, type Router } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/files/:id/:name', [AttachmentDeliveryController, 'show']).name('files.show')
}
`,
      'app/Http/Controllers/Side.ts': SIDE_EFFECT_CONTROLLER,
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(existsSync(join(dir, 'side-effect.txt'))).toBe(false)
  }, 30_000)

  test('names the controller file a timeout struck in', async () => {
    const dir = await app('scan-hang', {
      'routes/web.ts': INLINE_ROUTES,
      'app/Http/Controllers/Hang.ts': 'await new Promise(() => {})\nexport {}\n',
    })

    const message = expectFailure(await introspectApp(dir, { timeoutMs: 4000 }), 'timeout')

    expect(message).toContain('app/Http/Controllers/Hang.ts')
  }, 30_000)

  test('reports a listen() refusal from a scanned controller file as a warning, not a crash', async () => {
    const dir = await app('scan-listen', {
      'routes/web.ts': INLINE_ROUTES,
      'app/Http/Controllers/Serving.ts': "import app from '../../../src/app.js'\nvoid app.listen({ port: 0 })\n",
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.warnings.map((warning) => warning.code)).toContain('unhandled-rejection')
  }, 30_000)

  test('does not describe the fallback engine for an attachments section the server could not verify', async () => {
    const dir = await app('attachments-deferred', {
      'src/app.ts': `import { configureAttachments, createApp, ServiceProvider, StorageManager } from '@guren/core'

const { engine } = configureAttachments({
  table: { [Symbol.for('drizzle:Name')]: 'attachments' },
  storage: () => new StorageManager(),
  disk: 'media',
  processor: null,
})

class DeferredAttachmentsProvider extends ServiceProvider {
  static override deferred = true
  static override provides = ['attachments']

  register(): void {
    engine.bindTo(this.container)
  }
}

export default createApp({ providers: [DeferredAttachmentsProvider] })
`,
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.attachments).toBeUndefined()
    expect(result.manifest.warnings.map((warning) => warning.code)).toContain('section-unverified')
  }, 30_000)

  test('describes an attachments engine no provider binds, through core\'s fallback', async () => {
    const dir = await app('attachments-fallback', {
      'src/app.ts': `import { configureAttachments, createApp, registerAttachmentRoutes, StorageManager } from '@guren/core'

configureAttachments({
  table: { [Symbol.for('drizzle:Name')]: 'attachments' },
  storage: () => new StorageManager(),
  disk: 'media',
  delivery: {},
  processor: null,
})

export default createApp({ routes: registerAttachmentRoutes })
`,
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.attachments).toMatchObject({
      configured: true,
      table: 'attachments',
      disk: 'media',
      delivery: { routeName: 'attachments.show', mounted: true },
    })
  }, 30_000)

  test('memoises one run per app root and timeout, whatever spelling names the root', async () => {
    // A root that does not exist fails at spawn, so no child runs for this check.
    const dir = join(root, 'memo-missing')
    const spelled = `${relative(process.cwd(), dir)}/`

    expect(introspectApp(dir)).toBe(introspectApp(spelled))
    expect(introspectApp(dir, { timeoutMs: 60_000 })).not.toBe(introspectApp(dir))
    await Promise.all([introspectApp(dir), introspectApp(dir, { timeoutMs: 60_000 })])
  })

  test('runs a fresh child outside the memo, neither reading nor filling it', async () => {
    const dir = join(root, 'fresh-missing')

    const first = introspectApp(dir, { fresh: true })
    const memoised = introspectApp(dir)
    expect(first).not.toBe(memoised)
    expect(introspectApp(dir, { fresh: true })).not.toBe(first)
    expect(introspectApp(dir)).toBe(memoised)
    await Promise.all([first, memoised])
  })

  test('reports crashed, never a rejection, when the process cannot be spawned', async () => {
    const message = expectFailure(await introspectApp(join(root, 'does-not-exist')), 'crashed')

    expect(message).toContain('could not run')
  }, 30_000)

  test('reports crashed when the child dies before reporting', async () => {
    const dir = await app('dies', { 'src/main.ts': 'process.exit(3)\n' })

    expect(expectFailure(await introspectApp(dir), 'crashed')).toContain('exited with code 3')
  }, 30_000)

  test('reports no-entry for a directory without src/main.ts', async () => {
    const dir = join(root, 'empty')
    await writeWorkspaceFiles(dir, { 'bunfig.toml': '[install]\nauto = "disable"\n' })

    expect(expectFailure(await introspectApp(dir), 'no-entry')).toContain('src/main')
  }, 30_000)

  test('reports import when the entry fails to load', async () => {
    const dir = await app('import', { 'routes/web.ts': "import './missing-module.js'\nexport function registerWebRoutes(): void {}\n" })

    expect(expectFailure(await introspectApp(dir), 'import')).toContain('missing-module')
  }, 30_000)

  test('reports crashed when the entry loads but registration throws', async () => {
    const dir = await app('registrar-throws', {
      'routes/web.ts': "export function registerWebRoutes(): void {\n  throw new Error('registrar exploded')\n}\n",
    })

    expect(expectFailure(await introspectApp(dir), 'crashed')).toContain('registrar exploded')
  }, 30_000)

  test('carries an unrelated unhandled rejection into the manifest warnings', async () => {
    const dir = await app('rejection', {
      'src/main.ts': "import app from './app.js'\n\nvoid Promise.reject(new Error('stray rejection'))\n\nexport default app\n",
    })

    const result = await introspectApp(dir)

    if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    expect(result.manifest.warnings).toContainEqual({ code: 'unhandled-rejection', message: 'stray rejection' })
  }, 30_000)

  test('names the check cap on a timeout under it, on the first line, so a slower `guren introspect` reads as no contradiction', () => {
    const timedOut = withCapNote({ status: 'failed', reason: 'timeout', message: 'The app did not finish within 10000ms.\nmore' })
    const crashed = { status: 'failed', reason: 'crashed', message: 'exited' } as const

    expect(timedOut).toMatchObject({
      reason: 'timeout',
      message: 'The app did not finish within 10000ms. The commands that judge the app cap introspection at 10 s; `guren introspect` waits 30 s by default.\nmore',
    })
    expect(withCapNote(crashed)).toBe(crashed)
  })

  test('reports timeout when a provider never finishes registering, and kills what it spawned', async () => {
    const dir = await app('timeout', { 'src/app.ts': spawningApp(true) })

    const message = expectFailure(await introspectApp(dir, { timeoutMs: 4000 }), 'timeout')
    expect(message).toContain('4000ms')
    expect(message).not.toContain('cap introspection')
    const pid = Number(await readFile(join(dir, 'helper.pid'), 'utf8'))
    await waitFor(() => !isAlive(pid))
  }, 30_000)

  test.each([
    ['awaited', 'await app.listen({ port: 0 })'],
    ['bare', 'void app.listen({ port: 0 })'],
    ['in bootstrap()', 'export async function bootstrap() {\n  await app.listen({ port: 0 })\n  return app\n}'],
    ['in ready', 'export const ready = app.listen({ port: 0 })'],
  ])('reports a module-scope listen() (%s) as crashed, pointing at bin/serve.ts', async (name, call) => {
    const dir = await app(`listen-${name.replace(/\W+/gu, '-')}`, {
      'src/main.ts': `import app from './app.js'\n\n${call}\n\nexport default app\n`,
    })

    const message = expectFailure(await introspectApp(dir), 'crashed')

    expect(message).toContain('GUREN_INTROSPECT=1')
    expect(message).toContain('bin/serve.ts')
  }, 30_000)

  test('reports old-server before importing the entry', async () => {
    const dir = join(root, 'old-server')
    await writeWorkspaceFiles(dir, {
      ...fakeCore('export class Application { boot() {} listen() {} }\n'),
      'src/main.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('imported.txt', 'booted')\nexport default { listen() {} }\n",
    })

    expect(expectFailure(await introspectApp(dir), 'old-server')).toContain('introspect()')
    expect(existsSync(join(dir, 'imported.txt'))).toBe(false)
  }, 30_000)

  test('reports old-server when the app object itself has no introspect()', async () => {
    const dir = join(root, 'old-app-object')
    await writeWorkspaceFiles(dir, {
      ...fakeCore('export class Application { async introspect() {} }\n'),
      'src/main.ts': 'export default { listen() {} }\n',
    })

    expect(expectFailure(await introspectApp(dir), 'old-server')).toContain('may already have run')
  }, 30_000)

  test('reports crashed for a manifest of a schema version this CLI does not read', async () => {
    const dir = join(root, 'schema-version')
    await writeWorkspaceFiles(dir, {
      ...fakeCore('export class Application { async introspect() {} }\n'),
      'src/main.ts': 'export default { listen() {}, async introspect() { return { schemaVersion: 2, entry: {}, routes: [], warnings: [] } } }\n',
    })

    expect(expectFailure(await introspectApp(dir), 'crashed')).toContain('schemaVersion 2')
  }, 30_000)

  test('reports crashed when no framework module resolves from the entry', async () => {
    const dir = join(root, 'no-framework')
    await writeWorkspaceFiles(dir, {
      ...BARE_APP,
      'src/main.ts': 'export default { listen() {} }\n',
    })

    expect(expectFailure(await introspectApp(dir), 'crashed')).toContain('Neither @guren/core nor @guren/server')
  }, 30_000)
})

describe('what a register() spawned', () => {
  test('is gone after a run that finished', async () => {
    const dir = await app('spawn-finished', { 'src/app.ts': spawningApp(false) })

    expect((await introspectApp(dir)).status).toBe('ok')
    const pid = Number(await readFile(join(dir, 'helper.pid'), 'utf8'))

    await waitFor(() => !isAlive(pid))
  }, 30_000)

  test.each(['SIGINT', 'SIGKILL'] as const)('is gone when the CLI dies by %s', async (signal) => {
    const dir = await app(`spawn-${signal}`, { 'src/app.ts': spawningApp(true) })
    const cli = Bun.spawn(['bun', CLI_BIN_PATH, 'introspect', '--timeout', '60'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
    const pidFile = join(dir, 'helper.pid')
    await waitFor(() => existsSync(pidFile))
    const pid = Number(await readFile(pidFile, 'utf8'))

    cli.kill(signal)
    await cli.exited

    await waitFor(() => !isAlive(pid))
  }, 30_000)
})

/** An entry that records the child's pid and then computes forever, starving the child's event loop. */
const SPINNING_ENTRY = {
  ...fakeCore('export class Application { async introspect() {} }\n'),
  'src/main.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('child.pid', String(process.pid))\nwhile (true) {}\nexport default {}\n",
}

describe('a child whose app never yields', () => {
  test('exits on its own once the CLI dies by SIGKILL', async () => {
    const dir = join(root, 'orphan-spin')
    await writeWorkspaceFiles(dir, SPINNING_ENTRY)
    const cli = Bun.spawn(['bun', CLI_BIN_PATH, 'introspect', '--timeout', '60'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
    const pidFile = join(dir, 'child.pid')
    await waitFor(() => existsSync(pidFile))
    const pid = Number(await readFile(pidFile, 'utf8'))

    cli.kill('SIGKILL')
    await cli.exited

    try {
      await waitFor(() => !isAlive(pid), 5000)
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 30_000)

  test('ends itself past its budget while the CLI still holds it, reporting nothing', async () => {
    const dir = join(root, 'budget-spin')
    await writeWorkspaceFiles(dir, SPINNING_ENTRY)
    const resultFile = join(dir, 'result.json')
    const started = Date.now()

    const run = await runCaptured(
      [bunExecutable(), join(repoRoot, 'packages/cli/src/introspect-child.ts'), resultFile, '1500'],
      dir,
      { timeoutMs: 20_000, env: { GUREN_INTROSPECT: '1' }, processGroup: true },
    )

    expect(run.timedOut).toBeUndefined()
    expect(run.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(existsSync(resultFile)).toBe(false)
  }, 30_000)

  // Guards the margin's sign: a budget ending before the cap would pre-empt the parent's report.
  test('still reports the timeout itself, its budget running past the cap', async () => {
    const dir = join(root, 'timeout-spin')
    await writeWorkspaceFiles(dir, SPINNING_ENTRY)

    expect(expectFailure(await introspectApp(dir, { timeoutMs: 4000 }), 'timeout')).toContain('4000ms')
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    await waitFor(() => !isAlive(pid), 5000)
  }, 30_000)

  test('reports timeout, not crashed, when the budget ends it while the CLI loop is blocked past the cap', async () => {
    const dir = join(root, 'blocked-parent-spin')
    await writeWorkspaceFiles(dir, SPINNING_ENTRY)
    const pidFile = join(dir, 'child.pid')

    const pending = introspectApp(dir, { timeoutMs: 3000, fresh: true })
    await waitFor(() => existsSync(pidFile))
    // Past the cap and the child's budget (cap + margin), as a synchronous scan in `guren check` can be.
    Bun.sleepSync(3000 + INTROSPECT_CHILD_BUDGET_MARGIN_MS + 2000)

    expect(expectFailure(await pending, 'timeout')).toContain('3000ms')
  }, 30_000)
})

describe('guren introspect --json', () => {
  test('prints the manifest, and exits non-zero with the failure as JSON', async () => {
    const dir = apps.ok ?? await app('ok')

    const empty = join(root, 'json-no-entry')
    await writeWorkspaceFiles(empty, { 'bunfig.toml': '[install]\nauto = "disable"\n' })

    const ok = await runCliBinCaptured(['introspect', '--json'], dir)
    const failed = await runCliBinCaptured(['introspect', '--json'], empty)

    expect(ok.exitCode).toBe(0)
    const manifest = JSON.parse(ok.stdout) as AppManifest
    expect(Object.keys(manifest).sort()).toEqual(expect.arrayContaining([
      'agentTools', 'bindings', 'entry', 'generatedAt', 'middlewareAliases', 'modules', 'providers', 'routes', 'runtime', 'schemaVersion', 'warnings',
    ]))
    expect(manifest.modules.map((entry) => entry.name)).toEqual(['billing', 'shop'])
    expect(failed.exitCode).toBe(1)
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed', reason: 'no-entry' })
  }, 60_000)
})

describe('introspectRunner()', () => {
  test('starts a caller-supplied run at most once, however often a check asks', async () => {
    let calls = 0
    const run = introspectRunner('/app', async (): Promise<Introspection> => (calls++, { status: 'failed', reason: 'import', message: 'x' }))!

    await Promise.all([run(), run()])
    await run()

    expect(calls).toBe(1)
    expect(introspectRunner('/app', false)).toBeUndefined()
    expect(introspectRunner('/app', undefined)).toBeUndefined()
  })

  test('reads `true` as the memoised run under the cap the gate uses, so check --ci and the gate agree', async () => {
    const dir = join(root, 'check-cap-missing')
    const run = await introspectRunner(dir, true)!()

    // The same result object is the same memoised child; the 30 s default is another.
    expect(run).toBe(await introspectApp(dir, { timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS }))
    expect(run).not.toBe(await introspectApp(dir))
  })
})
