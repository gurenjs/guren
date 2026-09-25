import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runAudit, type AuditFinding, type AuditReport } from '../src/audit'
import { runCheck } from '../src/check'
import { listModuleNames } from '../src/discovery'
import { generateEntityContext } from '../src/entity-context'
import { introspectApp } from '../src/introspect'
import { controllerImportFailures } from '../src/introspect-controller-file'
import {
  assertWorkspaceBuilt,
  createTempRoot,
  linkWorkspaceCore,
  linkWorkspacePackage,
  PG_SCHEMA_FIXTURE,
  runCliBinCaptured,
  SERVER_DIST_ENTRY,
  writeWorkspaceFiles,
} from './helpers'

const repoRoot = resolve(import.meta.dir, '../../..')

/** Any `{ safeParse }` validates, so no fixture needs zod. */
const PAYLOAD = `const Payload = { safeParse: (value: unknown) => ({ success: true as const, data: value }) }`

/** Registers the `auth` alias from a provider: a routes file loaded on its own never sees it. */
const APP_TS = `import { createApp, requireAuthenticated, ServiceProvider, type Router } from '@guren/core'
import billing from '../modules/billing/index.js'
import shop from '../modules/shop/index.js'
import { registerWebRoutes } from '../routes/web.js'

class RouteAliasProvider extends ServiceProvider {
  register(): void {
    this.container.make<Router>('router').aliasMiddleware('auth', requireAuthenticated())
  }
}

export default createApp({ routes: registerWebRoutes, providers: [RouteAliasProvider], modules: [billing, shop] })
`

const ROUTES = `import { authorizeMiddleware, Controller, type Router } from '@guren/core'
import NoteController from '../app/Http/Controllers/NoteController.js'
import PostController from '../app/Http/Controllers/PostController.js'

${PAYLOAD}

class InlineController extends Controller {
  async store() {
    return this.json(await this.input())
  }
}

export function registerWebRoutes(router: Router): void {
  router.middleware('auth').group((auth) => {
    auth.post('/posts', [PostController, 'store'])
  })
  router.put('/posts/:id', [PostController, 'update'], authorizeMiddleware('update'))
  router.middleware('auth.admin').group((admin) => {
    admin.delete('/posts/:id', [PostController, 'destroy'])
  })
  router.post('/notes', { body: Payload }, [NoteController, 'store'])
  router.post('/notes/import', [NoteController, 'import'])
  router.post('/tasks', [InlineController, 'store']).name('tasks.store').agent({})
}
`

const POST_CONTROLLER = `import { Controller } from '@guren/core'

${PAYLOAD}

export default class PostController extends Controller {
  async store() {
    return this.json(await this.validateBody(Payload))
  }

  async update() {
    return this.json(await this.validateBody(Payload))
  }

  async destroy() {
    return this.noContent()
  }
}
`

const NOTE_CONTROLLER = `import { Controller } from '@guren/core'

${PAYLOAD}

export default class NoteController extends Controller {
  async store() {
    return this.json(await this.input())
  }

  async import() {
    return this.json(await this.validateBody(Payload))
  }
}
`

const MODULE_INDEX = (name: string) => `import { defineModule } from '@guren/core'
import { ReportController } from './app/Http/Controllers/ReportController.js'
import StatsController from './app/Http/Controllers/StatsController.js'

export default defineModule({
  name: '${name}',
  prefix: '/${name}',
  routes: (router) => {
    router.post('/reports', [ReportController, 'store']).name('${name}_reports_store').agent({})
    router.get('/stats', [StatsController, 'index'])
  },
})
`

/** billing validates and authenticates; shop does neither. The name-keyed path reads whichever is scanned last for both. */
const REPORT_CONTROLLER = {
  billing: `import { Controller } from '@guren/core'

${PAYLOAD}

export class ReportController extends Controller {
  async store() {
    await this.auth.userOrFail()
    return this.json(await this.validateBody(Payload))
  }
}
`,
  shop: `import { Controller } from '@guren/core'

export class ReportController extends Controller {
  async store() {
    return this.json(await this.input())
  }
}
`,
}

const STATS_CONTROLLER = {
  billing: `import { Controller } from '@guren/core'
import { User } from '../../../../../app/Models/User.js'

export default class StatsController extends Controller {
  async index() {
    return this.json({ users: await User.all() })
  }
}
`,
  shop: `import { Controller } from '@guren/core'

export default class StatsController extends Controller {
  async index() {
    return this.json({ orders: 0 })
  }
}
`,
}

const USER_MODEL = `import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends defineModel(users) {}
`

let root: string

/** One directory per scenario: `introspectApp()` memoises per app root for the whole test process. */
async function scaffoldApp(name: string, overrides: Record<string, string> = {}): Promise<string> {
  const dir = join(root, name)
  await linkWorkspaceCore(dir)
  await linkWorkspacePackage('orm', dir)
  const files: Record<string, string> = {
    // Bun otherwise installs an unresolvable specifier from npm instead of failing.
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'package.json': JSON.stringify({ name, type: 'module' }),
    'src/main.ts': await readFile(join(repoRoot, 'packages/create-app/templates/default/src/main.ts'), 'utf8'),
    'src/app.ts': APP_TS,
    'routes/web.ts': ROUTES,
    'db/schema.ts': PG_SCHEMA_FIXTURE,
    'app/Models/User.ts': USER_MODEL,
    'app/Http/Controllers/PostController.ts': POST_CONTROLLER,
    'app/Http/Controllers/NoteController.ts': NOTE_CONTROLLER,
  }
  for (const module of ['billing', 'shop'] as const) {
    files[`modules/${module}/index.ts`] = MODULE_INDEX(module)
    files[`modules/${module}/app/Http/Controllers/ReportController.ts`] = REPORT_CONTROLLER[module]
    files[`modules/${module}/app/Http/Controllers/StatsController.ts`] = STATS_CONTROLLER[module]
  }
  await writeWorkspaceFiles(dir, { ...files, ...overrides })
  return dir
}

function byKey(report: AuditReport): Record<string, AuditFinding> {
  return Object.fromEntries(report.findings.map((finding) => [finding.key, finding]))
}

let app: string
let manifest: Record<string, AuditFinding>
let source: Record<string, AuditFinding>
let manifestReport: AuditReport

beforeAll(async () => {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  root = await createTempRoot('guren-audit-introspect-test-')
  app = await scaffoldApp('app')
  manifestReport = await runAudit({ cwd: app, introspect: true })
  manifest = byKey(manifestReport)
  source = byKey(await runAudit({ cwd: app, introspect: false }))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('guren audit against the introspected app (RFC 0026 §5)', () => {
  test('reads the manifest, and says so', () => {
    expect(manifestReport.routeSource).toEqual({ from: 'manifest' })
    expect(manifest['introspection-unavailable']).toBeUndefined()
  })

  test('judges each same-named controller against its own file, with no collision to report', () => {
    expect(manifest['controller-name-collision:ReportController']).toBeUndefined()
    expect(manifest['validation:POST /billing/reports']?.status).toBe('pass')
    expect(manifest['authz:POST /billing/reports']?.status).toBe('pass')
    expect(manifest['validation:POST /shop/reports']?.status).toBe('fail')
    expect(manifest['validation:POST /shop/reports']?.filePath).toBe('modules/shop/app/Http/Controllers/ReportController.ts')
    expect(manifest['authz:POST /shop/reports']?.status).toBe('warn')
  })

  test('without introspection, reports the collision and reads one file, the last scanned, for both', () => {
    expect(source['controller-name-collision:ReportController']?.status).toBe('fail')
    const verdicts = (label: string) => [source[`validation:${label}`]?.status, source[`authz:${label}`]?.status]
    expect(verdicts('POST /billing/reports')).toEqual(verdicts('POST /shop/reports'))
  })

  test('passes authentication through an alias a provider registers, which the routes file alone cannot resolve', () => {
    expect(manifest['authz:POST /posts']).toMatchObject({ status: 'pass', evidence: 'manifest' })
    expect(source['authz:POST /posts']).toMatchObject({ status: 'warn', evidence: 'static' })
    expect(source['authz:POST /posts']?.message).toContain('named like an auth guard')
  })

  test('names the ability of an authorization-only chain, and still warns: a guest reaches the gate', () => {
    expect(manifest['authz:PUT /posts/:id']?.status).toBe('warn')
    expect(manifest['authz:PUT /posts/:id']?.message).toContain("ability 'update'")
    expect(manifest['authz:PUT /posts/:id']?.message).toContain('null user')
    expect(source['authz:PUT /posts/:id']?.message).toContain('Inline middleware')
  })

  test('reports an unregistered alias ahead of a guard that would pass, since the route does not mount', async () => {
    const dir = await scaffoldApp('unresolved-beside-guard', {
      'routes/web.ts': ROUTES.replace("router.middleware('auth').group((auth) => {", "router.middleware('auth', 'auth.typo').group((auth) => {"),
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['authz:POST /posts']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(findings['authz:POST /posts']?.message).toContain("'auth.typo'")
  })

  test('reports an alias nothing in the app registers as unresolved, not as an unrecognized guard', () => {
    expect(manifest['authz:DELETE /posts/:id']?.status).toBe('warn')
    expect(manifest['authz:DELETE /posts/:id']?.message).toContain("'auth.admin' is not registered as an alias or group")
    expect(source['authz:DELETE /posts/:id']?.message).toContain('named like an auth guard')
  })

  test('passes a route whose contract validates the body from the manifest, and reads the body for one without', () => {
    expect(manifest['validation:POST /notes']).toMatchObject({ status: 'pass', evidence: 'manifest' })
    expect(source['validation:POST /notes']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['validation:POST /notes/import']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['validation:POST /notes/import']?.message).toContain('validates body')
  })

  test('still fails an agent-exposed route whose handler body cannot be read', () => {
    expect(manifest['validation:POST /tasks']?.status).toBe('fail')
    expect(source['validation:POST /tasks']?.status).toBe('fail')
  })
})

describe('guren audit on what the manifest cannot place', () => {
  test('a class declared in the routes file is not judged by a same-named controller file\'s body, in audit and check alike', async () => {
    const dir = await scaffoldApp('routes-file-class', {
      'routes/web.ts': ROUTES.replace(
        "import NoteController from '../app/Http/Controllers/NoteController.js'\n",
        '',
      ).replace(
        'class InlineController extends Controller {',
        'class NoteController extends Controller {\n  async store() {\n    return this.json(await this.input())\n  }\n\n  async import() {\n    return this.json(await this.input())\n  }\n}\n\nclass InlineController extends Controller {',
      ).replace(
        "router.post('/notes/import', [NoteController, 'import'])",
        "router.post('/notes/import', [NoteController, 'import']).name('notes_import').agent({})",
      ),
      // No agent route reaches a colliding class, so only the agent routes themselves start the introspection.
      'modules/shop/index.ts': "import { defineModule } from '@guren/core'\nexport default defineModule({ name: 'shop' })\n",
      'modules/shop/app/Http/Controllers/ReportController.ts': REPORT_CONTROLLER.shop.replace('class ReportController', 'class ShopReportController'),
      // The controller file's class validates and authorizes; the routed one does neither.
      'app/Http/Controllers/NoteController.ts': NOTE_CONTROLLER.replace(
        '  async import() {\n',
        "  async import() {\n    await this.authorize('import')\n",
      ),
    })
    const [manifest, source] = await Promise.all([
      runAudit({ cwd: dir, introspect: true }).then(byKey),
      runAudit({ cwd: dir, introspect: false }).then(byKey),
    ])

    expect(source['validation:POST /notes/import']?.status).toBe('pass')
    expect(manifest['validation:POST /notes/import']?.status).toBe('fail')
    expect(manifest['validation:POST /notes/import']?.message).toContain('could not be analyzed')
    expect(manifest['controller-name-collision:NoteController']).toBeUndefined()

    const authorization = async (introspect: boolean) => (await runCheck({ cwd: dir, introspect })).checks
      .find((result) => result.key === 'agent-route-authorization:POST:/notes/import')
    expect(await authorization(false)).toBeUndefined()
    expect((await authorization(true))?.message).toContain('could not be verified')
  })

  test('an unexported class a controller file routes itself keeps its own body', async () => {
    const dir = await scaffoldApp('colocated', {
      'routes/web.ts': "import type { Router } from '@guren/core'\nimport { registerNotes } from '../app/Http/Controllers/NoteController.js'\n\nexport function registerWebRoutes(router: Router): void {\n  registerNotes(router)\n}\n",
      'app/Http/Controllers/NoteController.ts': `import { Controller, type Router } from '@guren/core'

${PAYLOAD}

class NoteController extends Controller {
  async store() {
    await this.auth.userOrFail()
    return this.json(await this.validateBody(Payload))
  }
}

export function registerNotes(router: Router): void {
  router.post('/notes', [NoteController, 'store']).name('notes_store').agent({})
}
`,
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['validation:POST /notes']?.status).toBe('pass')
    expect(findings['authz:POST /notes']?.status).toBe('pass')
  })

  const LEGACY_ROUTES = "import { Controller, type Router } from '@guren/core'\n\nclass LegacyController extends Controller {\n  async store() {\n    return this.json(await this.input())\n  }\n}\n\nexport function registerWebRoutes(router: Router): void {\n  router.post('/legacy', [LegacyController, 'store'])\n}\n"
  const legacy = (options: { exported: boolean; validates: boolean; tail?: string }) => `import { Controller } from '@guren/core'

${PAYLOAD}

${options.exported ? 'export ' : ''}class LegacyController extends Controller {
  async store() {
    return this.json(await this.${options.validates ? 'validateBody(Payload)' : 'input()'})
  }
}

export const loaded = true
${options.tail ?? ''}`

  test('a class the routes file declares is not judged by an unexported same-named class in a controller file', async () => {
    const dir = await scaffoldApp('routes-file-beside-unexported', {
      'routes/web.ts': LEGACY_ROUTES,
      'app/Http/Controllers/Legacy.ts': legacy({ exported: false, validates: true }),
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['validation:POST /legacy']?.status).toBe('warn')
    expect(findings['validation:POST /legacy']?.message).toContain('could not be analyzed')
  })

  test('a controller file whose import throws is reported by the child, and its class does not stand in for the routes file\'s', async () => {
    const dir = await scaffoldApp('import-throws', {
      'routes/web.ts': LEGACY_ROUTES,
      'app/Http/Controllers/Broken.ts': legacy({ exported: true, validates: true, tail: "\nthrow new Error('broken at import')\n" }),
    })
    const introspection = await introspectApp(dir)
    if (introspection.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(introspection)}`)
    expect(controllerImportFailures(introspection.manifest)).toEqual(['app/Http/Controllers/Broken.ts'])

    // The routed class is the routes file's, which reads its body unvalidated: never a pass.
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['validation:POST /legacy']?.status).toBe('warn')
  })

  test('an unregistered alias is never passed by a guard, and names a provider whose introspect() hook replaced register()', async () => {
    const dir = await scaffoldApp('introspect-hook', {
      'src/app.ts': APP_TS.replace(
        "    this.container.make<Router>('router').aliasMiddleware('auth', requireAuthenticated())\n  }",
        "    this.container.make<Router>('router').aliasMiddleware('auth', requireAuthenticated())\n  }\n\n  override introspect(): void {}",
      ),
      'app/Http/Controllers/PostController.ts': POST_CONTROLLER.replace(
        '  async destroy() {\n',
        '  async destroy() {\n    await this.auth.userOrFail()\n',
      ),
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))

    expect(findings['authz:POST /posts']?.status).toBe('warn')
    expect(findings['authz:POST /posts']?.message).toContain(
      'fails at boot unless something introspection skips registers it: RouteAliasProvider.register() (its introspect() hook ran instead).',
    )
    expect(findings['authz:DELETE /posts/:id']?.status).toBe('warn')
  })

  test('an unregistered alias names a skipped createApp({ boot }) callback as what may register it', async () => {
    const dir = await scaffoldApp('boot-callback', {
      'src/app.ts': APP_TS.replace('modules: [billing, shop] })', 'modules: [billing, shop], boot: () => {} })'),
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['authz:DELETE /posts/:id']?.message).toContain('registers it: the createApp({ boot }) callback.')
  })

  test('names an anonymous default-export controller by its file', async () => {
    const dir = await scaffoldApp('anonymous-default', {
      'app/Http/Controllers/NoteController.ts': NOTE_CONTROLLER.replace('export default class NoteController', 'export default class'),
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))
    expect(findings['validation:POST /notes/import']?.message).toContain('NoteController.import (app/Http/Controllers/NoteController.ts)')
  })
})

describe('the body rules on the manifest path', () => {
  const WRITING_REPORT = (module: string) => `import { Controller } from '@guren/core'
import { User } from '../../../../../app/Models/User.js'

${PAYLOAD}

export class ReportController extends Controller {
  async store() {
    await this.auth.userOrFail()
    const data = await this.validateBody(Payload)
    return this.json(await User.forceCreate({ ...(data as object), module: '${module}' }))
  }
}
`

  const AGENT = `import { Agent, tool } from '@guren/plugin-ai'
import { z } from 'zod'
import { User } from '@/app/Models/User'

export class Onboarder extends Agent {
  static override scopes = ['tool:billing_reports_store'] as const
  instructions = 'Onboard.'

  tools() {
    return {
      invite: tool({
        inputSchema: z.object({ email: z.string() }),
        async execute({ email }) {
          return User.create({ email })
        },
      }),
    }
  }
}
`

  test('keys a force write in a shared class name by its file, and finds an agent tool\'s action by file', async () => {
    const dir = await scaffoldApp('writes', {
      'modules/billing/app/Http/Controllers/ReportController.ts': WRITING_REPORT('billing'),
      'app/Ai/Agents/Onboarder.ts': AGENT,
    })
    const findings = byKey(await runAudit({ cwd: dir, introspect: true }))

    expect(Object.keys(findings).filter((key) => key.startsWith('force-write-request-data:'))).toEqual([
      'force-write-request-data:modules/billing/app/Http/Controllers/ReportController.ts#ReportController.store',
    ])
    // Only billing's action touches users; shop's same-named class does not.
    expect(findings['ai-local-tool-write:Onboarder.invite']?.message).toContain('billing_reports_store')
    expect(findings['ai-local-tool-write:Onboarder.invite']?.message).not.toContain('shop_reports_store')
  })
})

describe('guren audit when the manifest cannot be used', () => {
  test('a failed introspection judges from the routes file and leaves one warning, exit code unchanged', async () => {
    const dir = await scaffoldApp('import-failure', {
      'src/app.ts': `import './missing-module.js'\n${APP_TS}`,
    })
    const report = await runAudit({ cwd: dir, introspect: true })
    const findings = byKey(report)

    expect(findings['introspection-unavailable']?.status).toBe('warn')
    expect(findings['introspection-unavailable']?.message).toContain('(import)')
    expect(report.routeSource).toEqual({ from: 'routes-file', reason: 'the app could not be introspected (import)' })
    expect(findings['controller-name-collision:ReportController']?.status).toBe('fail')
    expect(findings['authz:POST /posts']?.evidence).toBe('static')
  })

  test('a provider that threw judges from the routes file and names the provider', async () => {
    const dir = await scaffoldApp('provider-threw', {
      'src/app.ts': APP_TS.replace(
        "this.container.make<Router>('router').aliasMiddleware('auth', requireAuthenticated())",
        "this.container.make<Router>('router').aliasMiddleware('auth', requireAuthenticated())\n    throw new Error('env.DB is not bound')",
      ),
    })
    const report = await runAudit({ cwd: dir, introspect: true })
    const findings = byKey(report)

    expect(report.routeSource).toEqual({ from: 'routes-file', reason: expect.stringContaining('RouteAliasProvider threw in register()') })
    expect(findings['introspection-unavailable']).toBeUndefined()
    expect(findings['authz:POST /posts']).toMatchObject({ status: 'warn', evidence: 'static' })
  })

  test('an app with no mutating or body-carrying route is not introspected', async () => {
    const dir = await scaffoldApp('read-only', {
      'routes/web.ts': `import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n  router.get('/', (c) => c.text('home'))\n}\n`,
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'\nexport default defineModule({ name: 'billing' })\n`,
      'modules/shop/index.ts': `import { defineModule } from '@guren/core'\nexport default defineModule({ name: 'shop' })\n`,
    })
    const report = await runAudit({ cwd: dir, introspect: true })
    expect(report.routeSource).toEqual({ from: 'routes-file', reason: expect.stringContaining('no route mutates') })
  })

  test('an app with no routes file is not introspected, and the report says why', async () => {
    const dir = join(root, 'no-routes')
    await writeWorkspaceFiles(dir, { 'package.json': JSON.stringify({ name: 'no-routes', type: 'module' }) })
    const report = await runAudit({ cwd: dir, introspect: true })
    expect(report.routeSource).toEqual({ from: 'routes-file', reason: expect.stringContaining('no routes file at routes/web.ts') })
  })

  test('the CLI introspects by default and --no-introspect reads the routes file', async () => {
    const run = async (...flags: string[]): Promise<AuditReport> => {
      const { stdout } = await runCliBinCaptured(['audit', '--json', '--no-deps', ...flags], app)
      return JSON.parse(stdout) as AuditReport
    }
    const [introspected, fromSource] = await Promise.all([run(), run('--no-introspect')])
    expect(introspected.routeSource).toEqual({ from: 'manifest' })
    expect(fromSource.routeSource).toEqual({ from: 'routes-file' })
    expect(byKey(fromSource)['controller-name-collision:ReportController']?.status).toBe('fail')
  })
})

describe('the other controller-body consumers on the manifest path', () => {
  test('guren check reports an agent route collision only while no manifest places the class', async () => {
    const collision = (checks: Array<{ key: string }>) =>
      checks.some((result) => result.key === 'agent-route-controller-collision:ReportController')
    expect(collision((await runCheck({ cwd: app, introspect: false })).checks)).toBe(true)
    expect(collision((await runCheck({ cwd: app, introspect: true })).checks)).toBe(false)
  })

  test('guren context links a same-named controller\'s route only when its own body names the model', async () => {
    const statsRoutes = async (introspect: boolean) => {
      const context = await generateEntityContext('User', { cwd: app, introspect })
      return {
        linked: context.routes.filter((route) => route.path.endsWith('/stats')).map((route) => route.path),
        unverified: context.unverifiedRoutes.filter((route) => route.path.endsWith('/stats')).map((route) => route.path).sort(),
      }
    }
    expect(await statsRoutes(true)).toEqual({ linked: ['/billing/stats'], unverified: [] })
    expect(await statsRoutes(false)).toEqual({ linked: [], unverified: ['/billing/stats', '/shop/stats'] })
  })

  test('guren context pairs a route two modules share within its module, whatever order the app lists them in', async () => {
    const unprefixed = (name: string, inline: boolean) => `import { defineModule } from '@guren/core'
import StatsController from './app/Http/Controllers/StatsController.js'

export default defineModule({
  name: '${name}',
  routes: (router) => {
    router.get('/stats', [StatsController, 'index']${inline ? ', async (_c, next) => { await next() }' : ''})
  },
})
`
    const dir = await scaffoldApp('unprefixed-modules', {
      'modules/billing/index.ts': unprefixed('billing', false),
      'modules/shop/index.ts': unprefixed('shop', true),
    })
    // The app lists its modules against the order the CLI reads their directories in.
    const [first, second] = (await listModuleNames(dir)).reverse()
    await writeWorkspaceFiles(dir, {
      'src/app.ts': APP_TS.replace('modules: [billing, shop]', `modules: [${first}, ${second}]`),
    })

    const context = await generateEntityContext('User', { cwd: dir, introspect: true })
    const stats = context.routes.filter((route) => route.path === '/stats')
    expect(stats.map((route) => ({ file: (route.controller as { file?: string }).file, inline: route.hasInlineMiddleware ?? false }))).toEqual([
      { file: 'modules/billing/app/Http/Controllers/StatsController.ts', inline: false },
    ])
  })
})
