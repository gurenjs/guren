import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AppManifest } from '@guren/core'

import { introspectApp, resetIntrospections, type Introspection } from '../src/introspect'
import {
  assertWorkspaceBuilt,
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

function expectFailure(result: Introspection, reason: string): string {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed') throw new Error('unreachable')
  expect(result.reason).toBe(reason as never)
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
  resetIntrospections()
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

  test('memoises one run per app root', () => {
    const dir = apps.ok!

    expect(introspectApp(dir)).toBe(introspectApp(join(dir, '.')))
  })

  test('reports no-entry for a directory without src/main.ts', async () => {
    const dir = join(root, 'empty')
    await writeWorkspaceFiles(dir, { 'bunfig.toml': '[install]\nauto = "disable"\n' })

    expect(expectFailure(await introspectApp(dir), 'no-entry')).toContain('src/main')
  }, 30_000)

  test('reports import when the entry fails to load', async () => {
    const dir = await app('import', { 'routes/web.ts': "import './missing-module.js'\nexport function registerWebRoutes(): void {}\n" })

    expect(expectFailure(await introspectApp(dir), 'import')).toContain('missing-module')
  }, 30_000)

  test('reports timeout when a provider never finishes registering', async () => {
    const dir = await app('timeout', {
      'src/app.ts': `import { createApp, ServiceProvider } from '@guren/core'

class HangingProvider extends ServiceProvider {
  register(): Promise<void> {
    setInterval(() => {}, 1000)
    return new Promise(() => {})
  }
}

export default createApp({ providers: [HangingProvider] })
`,
    })

    expect(expectFailure(await introspectApp(dir, { timeoutMs: 1500 }), 'timeout')).toContain('1500ms')
  }, 30_000)

  test.each([
    ['awaited', 'await app.listen({ port: 0 })'],
    ['bare', 'void app.listen({ port: 0 })'],
  ])('reports a module-scope listen() (%s) as crashed, pointing at bin/serve.ts', async (name, call) => {
    const dir = await app(`listen-${name}`, {
      'src/main.ts': `import app from './app.js'\n\n${call}\n\nexport default app\n`,
    })

    const message = expectFailure(await introspectApp(dir), 'crashed')

    expect(message).toContain('GUREN_INTROSPECT=1')
    expect(message).toContain('bin/serve.ts')
  }, 30_000)

  test('reports old-server before importing the entry', async () => {
    const dir = join(root, 'old-server')
    await writeWorkspaceFiles(dir, {
      'bunfig.toml': '[install]\nauto = "disable"\n',
      'package.json': JSON.stringify({ name: 'old-server-fixture', type: 'module' }),
      'node_modules/@guren/core/package.json': JSON.stringify({ name: '@guren/core', type: 'module', exports: { '.': './index.js' } }),
      'node_modules/@guren/core/index.js': 'export class Application { boot() {} listen() {} }\n',
      'src/main.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('imported.txt', 'booted')\nexport default { listen() {} }\n",
    })

    expect(expectFailure(await introspectApp(dir), 'old-server')).toContain('introspect()')
    expect(existsSync(join(dir, 'imported.txt'))).toBe(false)
  }, 30_000)
})

describe('guren introspect --json', () => {
  test('prints the manifest, and exits non-zero with the failure as JSON', async () => {
    const dir = apps.ok!

    const ok = await runCliBinCaptured(['introspect', '--json'], dir)
    const failed = await runCliBinCaptured(['introspect', '--json'], join(root, 'empty'))

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
