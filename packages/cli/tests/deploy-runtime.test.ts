import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { BUILT_IN_SESSION_DRIVERS, type AppManifest } from '@guren/server'
import {
  analyzeDeployRuntime,
  checkDeployRuntime,
  judgeDeployRuntime,
  judgeDeployVerdicts,
  readDeployManifestFacts,
  readDeployRuntime,
  type DeployRuntimeAnalysis,
  type DeployRuntimeVerdict,
} from '../src/deploy-runtime'
import type { Introspection } from '../src/introspect'
import { APP_FIXTURE, DEFAULT_ROUTES_FIXTURE, ENV_SCHEMA_FIXTURE, manifestFixture, SQLITE_SCHEMA_FIXTURE } from './helpers'
import { makeAuth } from '../src/make-auth'
import { runCheck } from '../src/check'
import { gatingResults } from '../src/check-result'
import { buildJsonOutput, getDoctorRuleEvaluations, runDoctor } from '../src/doctor'
import { createTempWorkspace } from './helpers'

let consoleLogSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  // runDoctor({ json: true }) writes the report to stdout.
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
})

const DEPLOY_CHECK_KEYS = [
  'deploy-password-hashing',
  'deploy-runtime-stores',
  'deploy-provider-discovery',
] as const

/**
 * Write a throwaway app tree. `files` keys are project-relative paths;
 * `dependencies` is merged into the generated package.json.
 */
async function writeApp(
  dir: string,
  files: Record<string, string>,
  dependencies: Record<string, string> = {},
): Promise<void> {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'deploy-runtime-fixture', dependencies }, null, 2),
    'utf8',
  )

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(dir, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
  }
}

async function withApp<T>(
  prefix: string,
  files: Record<string, string>,
  dependencies: Record<string, string>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const workspace = await createTempWorkspace(prefix)
  try {
    await writeApp(workspace.dir, files, dependencies)
    return await run(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

/** An introspection that reports `manifest`, so a test judges the scan beside a known app. */
function introspected(manifest: AppManifest): () => Promise<Introspection> {
  return async () => ({ status: 'ok', manifest })
}

/**
 * The three deploy verdicts, keyed for direct assertion, over the source in `cwd` and the
 * introspected app `manifest` describes: by default one registering nothing but the default hasher.
 */
async function deployChecks(cwd: string, manifest: AppManifest = manifestFixture()): Promise<Record<string, DeployRuntimeVerdict>> {
  const analysis = await readDeployRuntime(cwd, { introspect: introspected(manifest) })
  return Object.fromEntries(judgeDeployVerdicts(analysis).map((verdict) => [verdict.key, verdict]))
}

function statuses(checks: Record<string, DeployRuntimeVerdict>): Record<string, string> {
  return Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.status]))
}

/** An `auth.sessionOptions.store` factory: the one session the manifest leaves to the constructions in source. */
const FACTORY_SESSION = manifestFixture({
  session: {
    source: 'auth.sessionOptions.store',
    default: 'sessionOptions.store',
    stores: { 'sessionOptions.store': { driver: null, perProcess: null } },
  },
})

const PASSWORD_LOGIN_CONTROLLER = `import { Controller } from '@guren/core'
export default class LoginController extends Controller {
  async store() {
    return this.auth.attempt({ email, password }, remember)
  }
}
`

/**
 * An OAuth-only app: it subclasses AuthenticatableModel and configures
 * passwordColumn, but never verifies or hashes a password.
 */
const SESSION_APP = `import { createApp } from '@guren/core'
export const app = createApp({ auth: { autoSession: true } })
`

describe('deploy target detection', () => {
  it('detects the Cloudflare plugin from package.json dependencies', async () => {
    await withApp('guren-deploy-cf-', {}, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.label).toBe('Cloudflare Workers')
      expect(targets[0].detectedVia).toContain('@guren/plugin-cloudflare')
    })
  })

  it('detects the Vercel plugin and marks it as a Bun runtime', async () => {
    await withApp('guren-deploy-vercel-', {}, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.label).toBe('Vercel')
      // buildVercelOutput emits `runtime: 'bun1.x'`, so Bun.password exists.
      expect(targets[0].profile.hasBunRuntime).toBe(true)
    })
  })

  it('detects the Lambda plugin from package.json dependencies', async () => {
    await withApp('guren-deploy-lambda-plugin-', {}, { '@guren/plugin-lambda': '^0.1.0' }, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.label).toBe('AWS Lambda')
      expect(targets[0].detectedVia).toContain('@guren/plugin-lambda')
    })
  })

  it('reports Lambda once when the plugin and the adapter import are both present', async () => {
    // Installing the plugin also scaffolds src/lambda.ts, so both detectors
    // fire on a normal plugin-based app and every warning would be doubled.
    const files = {
      'src/lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\n`,
    }

    await withApp('guren-deploy-lambda-both-', files, { '@guren/plugin-lambda': '^0.1.0' }, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].detectedVia).toContain('@guren/plugin-lambda')
    })
  })

  it('detects the Lambda adapter from a @guren/core/lambda import', async () => {
    const files = {
      'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\nexport const handler = createLambdaHandler(app)\n`,
    }

    await withApp('guren-deploy-lambda-', files, {}, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.label).toBe('AWS Lambda')
      expect(targets[0].detectedVia).toContain('lambda.ts')
    })
  })

  it('detects the Lambda adapter from the @guren/server/lambda path too', async () => {
    const files = {
      'src/lambda.ts': `import { createLambdaHandler } from '@guren/server/lambda'\n`,
    }

    await withApp('guren-deploy-lambda-server-', files, {}, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets.map((target) => target.profile.label)).toEqual(['AWS Lambda'])
    })
  })

  // The adapter is also detected from the call itself, not only from the
  // `@guren/*/lambda` import path — this fixture imports it from `@guren/core`,
  // which is not one of LAMBDA_IMPORT_SOURCES.
  it('detects the Lambda adapter from a createLambdaHandler call', async () => {
    const files = {
      'src/handler.ts': `import { createLambdaHandler } from '@guren/core'
export const handler = createLambdaHandler(app)
`,
    }

    await withApp('guren-deploy-lambda-call-', files, {}, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets.map((target) => target.profile.label)).toEqual(['AWS Lambda'])
    })
  })

  it('detects several targets at once', async () => {
    const files = { 'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\n` }
    const deps = { '@guren/plugin-cloudflare': '^0.2.0' }

    await withApp('guren-deploy-multi-', files, deps, async (dir) => {
      const { targets } = await readDeployRuntime(dir)

      expect(targets.map((target) => target.profile.label).sort()).toEqual(['AWS Lambda', 'Cloudflare Workers'])
    })
  })

  it('reports no target for a plain Bun app', async () => {
    await withApp('guren-deploy-none-', { 'src/app.ts': SESSION_APP }, {}, async (dir) => {
      expect((await readDeployRuntime(dir)).targets).toEqual([])
    })
  })
})

describe('deploy-password-hashing check', () => {
  it('does not warn on Vercel, whose functions run on Bun', async () => {
    const files = { 'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER }

    await withApp('guren-hash-vercel-', files, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('runs on Bun')
    })
  })
})

describe('deploy-runtime-stores check', () => {
  // autoSession defaults to true (AuthServiceProvider attaches session
  // middleware unless explicitly `false`), so an app that opts out entirely
  // must not be flagged for lacking a backed session store.
  it('does not warn when autoSession is explicitly false', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
export const app = createApp({ auth: { autoSession: false } })
`,
    }

    await withApp('guren-stores-no-session-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('pass')
    })
  })

  // make:auth's own scaffolding advice is literally "add auth: {} to your
  // createApp() options to enable sessions and CSRF" — this bare-object shape
  // must be caught even though it names neither autoSession nor sessionOptions.
  it('warns on a bare auth: {} with no backed store, the make:auth-recommended shape', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({ auth: {} })\n`,
    }

    await withApp('guren-stores-bare-auth-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  // The `auth` key is read off createApp's first argument positionally, and a
  // transparent assertion around the options object is not the object: without
  // unwrapping it, an app written this way loses the session signal entirely.
  it.each([' satisfies Record<string, unknown>', ' as const'])(
    'reads createApp options written with %s',
    async (suffix) => {
      const files = {
        'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({ auth: {} }${suffix})\n`,
      }

      await withApp('guren-stores-wrapped-auth-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
        const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

        expect(check.status).toBe('warn')
        expect(check.message).toContain('sessions are enabled')
      })
    },
  )

  // The `auth: {` match alone cannot see inside the object it opens, so
  // suppression comes from a whole-app check for `autoSession: false` rather
  // than from excluding it within the same regex pass.
  it('does not warn when autoSession: false sits inside the same auth: { line', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
export const app = createApp({ auth: { autoSession: false } })
`,
    }

    await withApp('guren-stores-bare-auth-disabled-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('passes once a DatabaseSessionStore is wired in', async () => {
    const files = {
      'src/app.ts': `import { createApp, DatabaseSessionStore } from '@guren/core'
import { sessions } from '@/db/schema'
export const app = createApp({
  auth: { autoSession: true, sessionOptions: { store: new DatabaseSessionStore(sessions) } },
})
`,
    }

    await withApp('guren-stores-session-ok-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('pass')
    })
  })

  // A store that is imported but never constructed is not remediation: the
  // import survives refactors that drop the actual wiring.
  it('still warns when a backed store is imported but never constructed', async () => {
    const files = {
      'src/app.ts': `import { createApp, DatabaseSessionStore } from '@guren/core'
export const app = createApp({ auth: { autoSession: true, sessionOptions: {} } })
`,
    }

    await withApp('guren-stores-import-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  it('accepts a store constructed in a different module than it is used', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
import { sessionStore } from './stores'
export const app = createApp({ auth: { autoSession: true, sessionOptions: { store: sessionStore } } })
`,
      'src/stores.ts': `import { DatabaseSessionStore } from '@guren/core'
export const sessionStore = new DatabaseSessionStore(sessions)
`,
    }

    await withApp('guren-stores-split-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('accepts a Redis-backed session store as remediation', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
import { RedisSessionStore } from '@guren/core/redis'
export const app = createApp({
  auth: { autoSession: true, sessionOptions: { store: new RedisSessionStore(redis) } },
})
`,
    }

    await withApp('guren-stores-redis-', files, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('warns when OAuth is configured with no backed state store', async () => {
    const files = {
      'app/Providers/OAuthProvider.ts': `import { createOAuthManager } from '@guren/core'
export const oauth = createOAuthManager({})
`,
    }

    await withApp('guren-stores-oauth-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('OAuth is configured')
      expect(check.message).toContain('DatabaseOAuthStateStore')
      expect(check.fix).toContain('DatabaseOAuthStateStore')
      // Nothing here is about sessions, and an app from `make:auth` already has a store.
      expect(check.fix).not.toContain('guren add session')
    })
  })

  it('passes for the app `make:auth --install --oauth --oauth-only` scaffolds', async () => {
    const files = {
      'src/app.ts': APP_FIXTURE,
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'db/schema.ts': SQLITE_SCHEMA_FIXTURE,
    }

    await withApp('guren-stores-make-auth-oauth-', files, { '@guren/plugin-cloudflare': '^0.10.0' }, async (dir) => {
      await makeAuth({ install: true, force: true, oauth: 'github', oauthOnly: true })

      const analysis = await readDeployRuntime(dir)
      expect(analysis.oauthSignals.map((signal) => signal.symbol)).toEqual(['createOAuthManager'])

      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  // RFC 0027 §2: a definition binds `oauth` without createOAuthManager or the Core provider.
  for (const [label, schema, status] of [['with', SQLITE_SCHEMA_FIXTURE, 'pass'], ['without', null, 'warn']] as const) {
    it(`judges the config/oauth.ts make:auth --oauth writes ${label} a db/schema.ts`, async () => {
      const files: Record<string, string> = {
        'src/app.ts': APP_FIXTURE,
        'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
        'config/env.ts': ENV_SCHEMA_FIXTURE,
        ...(schema ? { 'db/schema.ts': schema } : {}),
      }

      await withApp(`guren-stores-oauth-definition-${label}-`, files, { '@guren/plugin-cloudflare': '^0.10.0' }, async (dir) => {
        await makeAuth({ install: true, force: true, oauth: 'github', oauthOnly: true })

        const analysis = await readDeployRuntime(dir)
        expect(analysis.oauthSignals.map((signal) => signal.symbol)).toEqual(['defineOAuthConfig'])
        expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe(status)
      })
    })
  }

  // Without these the whole BACKED_OAUTH_PATTERNS table could be broken with
  // every other test still passing, warning at a correctly-configured app.
  for (const store of ['DatabaseOAuthStateStore', 'RedisOAuthStateStore'] as const) {
    it(`passes once ${store} is constructed`, async () => {
      const files = {
        'app/Providers/OAuthProvider.ts': `import { createOAuthManager, ${store} } from '@guren/core'
export const oauth = createOAuthManager({ stateStore: new ${store}(oauthStates) })
`,
      }

      await withApp(`guren-stores-oauth-ok-${store}-`, files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
        expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
      })
    })
  }

  it('still warns when a backed OAuth store is imported but never constructed', async () => {
    const files = {
      'app/Providers/OAuthProvider.ts': `import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
export const oauth = createOAuthManager({})
`,
    }

    await withApp('guren-stores-oauth-import-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('warn')
    })
  })

  it('treats OAuthServiceProvider as an OAuth signal', async () => {
    const files = {
      'src/app.ts': `import { createApp, OAuthServiceProvider } from '@guren/core'
export const app = createApp({ providers: [OAuthServiceProvider] })
`,
    }

    await withApp('guren-stores-oauth-provider-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('OAuth is configured')
    })
  })

  it('treats createSessionMiddleware as a session signal', async () => {
    const files = {
      'src/app.ts': `import { createSessionMiddleware } from '@guren/core'\napp.use('*', createSessionMiddleware({}))\n`,
    }

    await withApp('guren-stores-session-mw-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  it('warns about explicitly constructed in-memory cache and queue stores', async () => {
    const files = {
      'config/cache.ts': `import { MemoryStore } from '@guren/core'\nexport const store = new MemoryStore()\n`,
      'config/queue.ts': `import { MemoryDriver } from '@guren/core'\nexport const driver = new MemoryDriver()\n`,
    }

    await withApp('guren-stores-explicit-', files, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('constructed explicitly')
      expect(check.message).toContain('MemoryStore (config/cache.ts:2)')
      expect(check.message).toContain('MemoryDriver (config/queue.ts:2)')
    })
  })

  // Every entry in MEMORY_STORE_PATTERNS, so a typo in any one of them can't
  // hide behind the two that the cache/queue case above happens to cover.
  const MEMORY_STORES = [
    'MemorySessionStore',
    'MemoryOAuthStateStore',
    'MemoryApiTokenStore',
    'MemoryPasswordResetStore',
    'MemoryEmailVerificationStore',
    'MemoryRateLimitStore',
    'MemorySchedulerLock',
    'MemoryStore',
    'MemoryDriver',
  ] as const

  for (const store of MEMORY_STORES) {
    it(`warns about an explicitly constructed ${store}`, async () => {
      const files = {
        'config/stores.ts': `import { ${store} } from '@guren/core'\nexport const s = new ${store}()\n`,
      }

      await withApp(`guren-stores-mem-${store}-`, files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
        const check = (await deployChecks(dir))['deploy-runtime-stores']

        expect(check.status).toBe('warn')
        expect(check.message).toContain(`${store} (config/stores.ts:2)`)
      })
    })
  }

  it('gives an explicit MemoryOAuthStateStore the OAuth remedy, not the session one', async () => {
    const files = {
      'app/Providers/OAuthProvider.ts': `import { createOAuthManager, MemoryOAuthStateStore } from '@guren/core'
export const oauth = createOAuthManager({ stateStore: new MemoryOAuthStateStore() })
`,
    }

    await withApp('guren-stores-mem-oauth-fix-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.fix).toContain('DatabaseOAuthStateStore')
      expect(check.fix).not.toContain('guren add session')
    })
  })

  it('names both remedies when an OAuth state store and another memory store are constructed', async () => {
    const files = {
      'config/stores.ts': `import { MemoryOAuthStateStore, MemoryStore } from '@guren/core'
export const state = new MemoryOAuthStateStore()
export const cache = new MemoryStore()
`,
    }

    await withApp('guren-stores-mem-mixed-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.fix).toContain('drop OAuthServiceProvider')
      expect(check.fix).toContain('Redis-backed cache/queue driver')
    })
  })

  it('passes for an app with no session, OAuth, or in-memory store signals', async () => {
    const files = { 'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({})\n` }

    await withApp('guren-stores-api-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('no in-memory store defaults')
    })
  })
})

describe('deploy-provider-discovery check', () => {
  it('warns when a Workers app uses AutoDiscovery', async () => {
    const files = {
      'src/app.ts': `import { AutoDiscovery, createApp } from '@guren/core'
const discovery = new AutoDiscovery({ basePath: 'app' })
const result = await discovery.discover()
export const app = createApp({ providers: result.providers })
`,
    }

    await withApp('guren-discovery-cf-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-provider-discovery']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('AutoDiscovery')
      expect(check.message).toContain('Bun.Glob')
      expect(check.fix).toContain('providers')
    })
  })

  it('warns on Vercel because the bundle ships no app directory', async () => {
    const files = {
      'src/app.ts': `import { AutoDiscovery } from '@guren/core'
const discovery = new AutoDiscovery({ basePath: 'app' })
`,
    }

    await withApp('guren-discovery-vercel-', files, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-provider-discovery']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('bun build` bundle')
    })
  })

  // A bare import is not active use: it survives refactors that drop the
  // discovery call itself.
  it('does not warn on an AutoDiscovery import that is never constructed', async () => {
    const files = { 'src/app.ts': `import { AutoDiscovery } from '@guren/core'\n` }

    await withApp('guren-discovery-import-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-provider-discovery'].status).toBe('pass')
    })
  })

  // ApplicationOptions does not declare `discover`, but an older app may
  // still carry the key: inert, so it must not read as discovery.
  it('does not warn on the inert discover: true option', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({ discover: true })\n`,
    }

    await withApp('guren-discovery-option-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-provider-discovery'].status).toBe('pass')
    })
  })

  it('passes when providers are listed explicitly', async () => {
    const files = {
      'src/app.ts': `import { createApp, DatabaseProvider } from '@guren/core'
export const app = createApp({ providers: [DatabaseProvider] })
`,
    }

    await withApp('guren-discovery-explicit-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-provider-discovery']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('provider discovery is not used')
    })
  })
})

describe('deploy-runtime checks without a deploy target', () => {
  it('all pass when no deploy plugin or Lambda adapter is present', async () => {
    const files = {
      // Every pattern the checks look for, none of which matters off-serverless.
      'src/app.ts': SESSION_APP,
      'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER,
      'config/cache.ts': `import { MemoryStore } from '@guren/core'\nexport const store = new MemoryStore()\n`,
      'config/discovery.ts': `import { AutoDiscovery } from '@guren/core'\n`,
    }

    await withApp('guren-deploy-no-target-', files, {}, async (dir) => {
      expect(statuses(await deployChecks(dir))).toEqual({
        'deploy-password-hashing': 'pass',
        'deploy-runtime-stores': 'pass',
        'deploy-provider-discovery': 'pass',
      })
    })
  })

  it('leaves the checks non-autofixable so `doctor --fix` never touches deploy config', async () => {
    const files = { 'src/app.ts': SESSION_APP }

    await withApp('guren-deploy-no-autofix-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir })
      const deployEvaluations = evaluations.filter((evaluation) => evaluation.check.key.startsWith('deploy-'))

      expect(deployEvaluations).toHaveLength(3)
      for (const evaluation of deployEvaluations) {
        expect(evaluation.check.canAutofix).toBeFalsy()
        expect(evaluation.autofix).toBeNull()
      }
    })
  })
})

describe('runDoctor integration', () => {
  it('surfaces the deploy checks through --json and --next without throwing', async () => {
    const files = { 'src/app.ts': SESSION_APP }

    await withApp('guren-deploy-report-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      // Not introspected: the session and cache stores are the registered app's to show.
      const report = await runDoctor({ cwd: dir, json: true, next: true })
      const json = buildJsonOutput(report)
      const byKey = new Map(json.checks.map((check) => [check.key, check]))

      expect([...byKey.keys()].filter((key) => key.startsWith('deploy-'))).toEqual([
        'deploy-password-hashing-unverified',
        'deploy-runtime-stores-unverified',
        'deploy-provider-discovery',
      ])

      // It must reach the operator as a warning with manual remediation and no autofix offer.
      const stores = byKey.get('deploy-runtime-stores-unverified')
      expect(stores?.status).toBe('warn')
      expect(stores?.canAutofix).toBe(false)
      expect(stores?.manualFix).toContain('guren introspect')

      expect(report.hasWarnings).toBe(true)
      expect(report.manualChecks.map((check) => check.key)).toContain('deploy-runtime-stores-unverified')
      expect(report.fixableChecks.map((check) => check.key)).not.toContain('deploy-runtime-stores-unverified')
      expect(json.summary.total).toBe(json.checks.length)
      expect(Array.isArray(json.nextSteps)).toBe(true)
    })
  })
})

describe('AST-based matching', () => {
  it('still warns on an aliased AutoDiscovery construction', async () => {
    const files = {
      'src/app.ts': `import { AutoDiscovery as Discovery } from '@guren/core'
const discovery = new Discovery({ basePath: 'app' })
`,
    }

    await withApp('guren-ast-alias-discovery-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-provider-discovery'].status).toBe('warn')
    })
  })

  it('recognizes an aliased backed session store', async () => {
    const files = {
      'src/app.ts': `import { createApp, DatabaseSessionStore as SessionStore } from '@guren/core'
export const app = createApp({ auth: { sessionOptions: { store: new SessionStore(sessions) } } })
`,
    }

    await withApp('guren-ast-alias-store-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  // Line-scanning could not see a value split from its key; the AST can.
  it('suppresses the session warning when autoSession: false spans multiple lines', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
export const app = createApp({
  auth: {
    autoSession:
      false,
  },
})
`,
    }

    await withApp('guren-ast-multiline-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  // The file imports the very symbols it names in prose, so source-aware name
  // filtering alone cannot carry this test — only comment/string handling can.
  it('ignores constructions inside comments and string literals', async () => {
    const files = {
      'src/notes.ts': `import { MemoryStore, MemoryDriver } from '@guren/core'

// migration note: replace new MemoryStore() before deploying
export const doc = 'call new MemoryDriver() to enqueue locally'
`,
    }

    await withApp('guren-ast-comments-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).memoryStoreSignals).toEqual([])
    })
  })

  // Both keys are generic enough that another library's config would claim
  // them; they only count inside a file that imports from Guren.
  it('ignores session option keys in a file with no Guren import', async () => {
    const files = {
      'config/other.ts': `export const cfg = { sessionOptions: { maxAge: 1 }, autoSession: true }\n`,
    }

    await withApp('guren-ast-foreign-session-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).sessionSignals).toEqual([])
    })
  })

  it('ignores an unrelated auth.attempt() in a file with no Guren import', async () => {
    const files = {
      'src/other.ts': `import { auth } from 'some-auth-sdk'\nexport const ok = await auth.attempt({})\n`,
    }

    await withApp('guren-ast-foreign-attempt-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).passwordAuthSignals).toEqual([])
    })
  })

  // Suppression stays ungated on purpose: missing an opt-out would warn a
  // correctly-configured app, the failure direction this check avoids.
  it('still reads autoSession: false from a file with no Guren import', async () => {
    const files = {
      'config/session.ts': `export const session = { autoSession: false }\n`,
      'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({ auth: {} })\n`,
    }

    await withApp('guren-ast-ungated-optout-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('ignores a signal name used only in an implements clause', async () => {
    const files = {
      'src/provider.ts': `import { OAuthServiceProvider } from '@guren/core'
export class Custom implements OAuthServiceProvider {}
`,
    }

    await withApp('guren-ast-implements-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).oauthSignals).toEqual([])
    })
  })

  it('ignores an auth key in a TypeScript type position', async () => {
    const files = {
      'src/types.ts': `export interface AppOptions {
  auth: { autoSession?: boolean }
}
`,
    }

    await withApp('guren-ast-type-pos-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).sessionSignals).toEqual([])
    })
  })

  // The make:auth mail config carries `auth: { user, pass }` for SMTP
  // credentials, so the auth-key signal is scoped to createApp options.
  it('does not read SMTP mailer auth config as a session', async () => {
    const files = {
      'config/mail.ts': `export const mail = {
  transport: 'smtp',
  auth: {
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
}
`,
    }

    await withApp('guren-ast-smtp-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('counts a shorthand auth property in createApp options', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
const auth = {}
export const app = createApp({ auth })
`,
    }

    await withApp('guren-ast-shorthand-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  it('does not let a same-named import from another package satisfy the store remediation', async () => {
    const files = {
      'src/app.ts': SESSION_APP,
      'src/stores.ts': `import { DatabaseSessionStore } from './my-own'\nexport const s = new DatabaseSessionStore(x)\n`,
    }

    await withApp('guren-ast-foreign-store-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores'].status).toBe('warn')
    })
  })

  // A decorator the parser cannot read makes the whole file unparseable, and
  // an unparseable file contributes nothing — hiding every signal it holds.
  it('still sees signals in a file that uses decorators', async () => {
    const files = {
      'src/app.ts': `import { AutoDiscovery } from '@guren/core'

@sealed
class Registry {
  @log accessor entries = []
}

const discovery = new AutoDiscovery({ basePath: 'app' })
`,
    }

    await withApp('guren-ast-decorators-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-provider-discovery'].status).toBe('warn')
    })
  })

  // Deliberately a *value* import: a `import type` one is filtered out of the
  // binding map before the walker runs, so it would pass without exercising
  // the type-node skip at all.
  it('ignores a value-imported signal name used only as a type', async () => {
    const files = {
      'src/types.ts': `import { OAuthServiceProvider } from '@guren/core'
export let provider: OAuthServiceProvider
export type Alias = OAuthServiceProvider
export function build(p: OAuthServiceProvider): typeof OAuthServiceProvider | null {
  return null
}
`,
    }

    await withApp('guren-ast-type-ref-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await readDeployRuntime(dir)).oauthSignals).toEqual([])
    })
  })

  it('resolves namespace imports for constructions and calls', async () => {
    const files = {
      'src/app.ts': `import * as guren from '@guren/core'
export const app = guren.createApp({ auth: {} })
export const oauth = guren.createOAuthManager({})
export const store = new guren.DatabaseSessionStore(sessions)
`,
    }

    await withApp('guren-ast-namespace-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)

      expect(analysis.sessionSignals.map((s) => s.symbol)).toContain('auth')
      expect(analysis.oauthSignals.map((s) => s.symbol)).toContain('createOAuthManager')
      expect(analysis.backedSessionSignals.map((s) => s.symbol)).toContain('DatabaseSessionStore')
    })
  })

  it('skips a file that fails to parse, and says so in the check message', async () => {
    const files = {
      'src/broken.ts': `export const = this is not valid typescript {{{`,
      'src/app.ts': SESSION_APP,
    }

    await withApp('guren-ast-broken-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)
      expect(analysis.unparsedFiles).toEqual(['src/broken.ts'])

      // The broken file contributes nothing and the valid one still signals,
      // with the incompleteness disclosed rather than silently absorbed.
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
      expect(check.message).toContain('could not be read or parsed and were not scanned: src/broken.ts')
    })
  })

  // The Lambda target is detected from source, so a skipped file can hide a
  // target entirely and "no deploy plugin detected" has to carry the caveat.
  it('carries the caveat on the no-target verdict, since a skipped file can hide a Lambda target', async () => {
    const files = { 'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\nexport const = broken {{{` }

    await withApp('guren-caveat-no-target-', files, {}, async (dir) => {
      const analysis = await readDeployRuntime(dir)
      expect(analysis.targets).toEqual([])
      expect(analysis.unparsedFiles).toEqual(['lambda.ts'])

      for (const check of Object.values(await deployChecks(dir))) {
        expect(check.message).toContain('No deploy plugin or Lambda adapter detected.')
        expect(check.message).toContain('could not be read or parsed')
      }
    })
  })

  it('adds no parse caveat when every file parses', async () => {
    const files = { 'src/app.ts': SESSION_APP }

    await withApp('guren-ast-clean-scan-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)
      expect(analysis.unparsedFiles).toEqual([])

      const check = (await deployChecks(dir))['deploy-runtime-stores']
      expect(check.message).not.toContain('could not be parsed')
    })
  })
})

describe('test files are excluded from the scan', () => {
  // A test fixture constructing a backed store would otherwise satisfy the
  // remediation check for an app that never wires one up.
  it('does not let a store constructed in a test file mask a production gap', async () => {
    const files = {
      'src/app.ts': SESSION_APP,
      'src/app.test.ts': `import { DatabaseSessionStore } from '@guren/core'
const store = new DatabaseSessionStore(sessions)
`,
    }

    await withApp('guren-scan-test-mask-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir, FACTORY_SESSION))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  for (const name of ['app.spec.ts', 'app.test.tsx', 'app.spec.js'] as const) {
    it(`excludes ${name}`, async () => {
      const files = {
        [`src/${name}`]: `import { MemoryStore } from '@guren/core'\nexport const s = new MemoryStore()\n`,
      }

      await withApp(`guren-scan-excl-${name}-`, files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
        expect((await readDeployRuntime(dir)).memoryStoreSignals).toEqual([])
      })
    })
  }

  it('does not raise a session signal from a test fixture alone', async () => {
    const files = {
      'src/routes.test.ts': `const app = createApp({ auth: { autoSession: true } })\n`,
    }

    await withApp('guren-scan-test-signal-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)

      expect(analysis.sessionSignals).toEqual([])
    })
  })
})

describe('readDeployRuntime', () => {
  // Every entry in DEPLOY_SCAN_DIRS: dropping one would silently stop the
  // whole scan there with no other test failing.
  for (const dir of ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const) {
    it(`scans the ${dir}/ directory`, async () => {
      const files = {
        [`${dir}/probe.ts`]: `import { MemoryStore } from '@guren/core'\nexport const s = new MemoryStore()\n`,
      }

      await withApp(`guren-deploy-scan-${dir}-`, files, {}, async (workspace) => {
        const analysis = await readDeployRuntime(workspace)

        expect(analysis.memoryStoreSignals.map((signal) => signal.filePath)).toContain(`${dir}/probe.ts`)
      })
    })
  }

  it('scans source files sitting directly in the project root', async () => {
    const files = { 'worker.ts': `import { MemoryStore } from '@guren/core'\nexport const s = new MemoryStore()\n` }

    await withApp('guren-deploy-scan-root-', files, {}, async (dir) => {
      const analysis = await readDeployRuntime(dir)

      expect(analysis.memoryStoreSignals.map((signal) => signal.filePath)).toContain('worker.ts')
    })
  })

  it('scans modules/ trees as well as the project root', async () => {
    const files = {
      'modules/billing/index.ts': `import { MemoryStore } from '@guren/core'\nexport const store = new MemoryStore()\n`,
    }

    await withApp('guren-deploy-modules-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)

      expect(analysis.memoryStoreSignals.map((signal) => signal.filePath)).toContain(
        'modules/billing/index.ts',
      )
    })
  })

  it('ignores node_modules so a dependency\'s own sources never trip a check', async () => {
    const files = {
      'node_modules/@guren/core/dist/index.ts': `export class MemoryStore {}\nconst s = new MemoryStore()\n`,
      'src/app.ts': `import { createApp } from '@guren/core'\nexport const app = createApp({})\n`,
    }

    await withApp('guren-deploy-node-modules-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await readDeployRuntime(dir)

      expect(analysis.memoryStoreSignals).toEqual([])
    })
  })
})

// The same verdicts `guren doctor` reports, reached from `guren check` and
// the deploy builds (RFC 0020 Part 0).
const UNCONFIGURED_SESSION = manifestFixture({
  session: { source: 'none', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } },
})

describe('checkDeployRuntime', () => {
  it('returns nothing for an app with no deploy target', async () => {
    await withApp('guren-deploy-check-plain-', { 'src/app.ts': SESSION_APP }, {}, async (dir) => {
      expect(await checkDeployRuntime(dir)).toEqual([])
    })
  })

  it('returns every verdict, passing ones included, for a deploy target', async () => {
    await withApp(
      'guren-deploy-check-cf-',
      { 'src/app.ts': SESSION_APP },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const verdicts = await checkDeployRuntime(dir, { introspect: introspected(UNCONFIGURED_SESSION) })

        expect(verdicts.map((verdict) => verdict.key)).toEqual([...DEPLOY_CHECK_KEYS])
        const stores = verdicts.find((verdict) => verdict.key === 'deploy-runtime-stores')!
        expect(stores).toMatchObject({ status: 'warn', evidence: 'manifest' })
        expect(stores.fix).toContain('guren add session')
        const hashing = verdicts.find((verdict) => verdict.key === 'deploy-password-hashing')!
        expect(hashing.status).toBe('pass')
        expect(hashing.fix).toBeUndefined()
      },
    )
  })

  it('reports the hashing and store verdicts unverified without the introspected app, never judged from source', async () => {
    await withApp(
      'guren-deploy-check-no-introspect-',
      { 'src/app.ts': SESSION_APP, 'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const verdicts = await checkDeployRuntime(dir, { introspect: false })

        expect(verdicts.map((verdict) => verdict.key)).toEqual([
          'deploy-password-hashing-unverified',
          'deploy-runtime-stores-unverified',
          'deploy-provider-discovery',
        ])
        for (const verdict of verdicts.slice(0, 2)) {
          expect(verdict).toMatchObject({ status: 'warn', evidence: 'none', evidenceReason: 'the app was not introspected' })
          expect(verdict.fix).toContain('guren introspect')
        }
        expect(verdicts[1]!.message).toContain('whether the session and cache stores are per-process is unverified')
      },
    )
  })

  it('names a failed introspection as the reason', async () => {
    await withApp('guren-deploy-check-failed-', { 'src/app.ts': SESSION_APP }, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const failed = async (): Promise<Introspection> => ({ status: 'failed', reason: 'import', message: 'Could not load src/main.ts.\nstack' })
      const [hashing, stores] = await checkDeployRuntime(dir, { introspect: failed })

      expect(hashing!.evidenceReason).toBe('introspection failed with import: Could not load src/main.ts')
      expect(stores!.message).toContain('unverified: introspection failed with import: Could not load src/main.ts')
    })
  })

  it('matches what guren doctor reports for the same app', async () => {
    await withApp(
      'guren-deploy-check-parity-',
      { 'src/app.ts': SESSION_APP },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir })
        const doctor = new Map(evaluations.map(({ check }) => [check.key, check]))
        for (const verdict of await checkDeployRuntime(dir, { introspect: false })) {
          expect(doctor.get(verdict.key)).toMatchObject({ status: verdict.status, message: verdict.message })
        }
      },
    )
  })
})

describe('deprecated analysis entry points', () => {
  it('warn once and judge as checkDeployRuntime does', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withApp('guren-deploy-deprecated-', { 'src/app.ts': SESSION_APP }, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
        const analysis = await analyzeDeployRuntime(dir, { introspect: introspected(UNCONFIGURED_SESSION) })
        await analyzeDeployRuntime(dir, { introspect: false })
        const verdicts = judgeDeployRuntime(analysis)

        expect(verdicts).toEqual(await checkDeployRuntime(dir, { introspect: introspected(UNCONFIGURED_SESSION) }))
        expect(analysis.bunOnlyHasherSignals).toEqual([])
        const warnings = warn.mock.calls.map(([message]) => String(message))
        expect(warnings.filter((message) => message.includes('analyzeDeployRuntime() is deprecated'))).toHaveLength(1)
        expect(warnings.filter((message) => message.includes('judgeDeployRuntime() is deprecated'))).toHaveLength(1)
        expect(warnings[0]).toContain('[guren] Deprecation (deploy-runtime-analysis)')
      })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('guren check deploy-runtime verdicts', () => {
  it('reports the stores verdict as an advisory warn that no gate counts', async () => {
    await withApp(
      'guren-check-deploy-cf-',
      { 'src/app.ts': SESSION_APP },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const report = await runCheck({ cwd: dir, introspect: introspected(UNCONFIGURED_SESSION) })
        const stores = report.checks.find((result) => result.key === 'deploy-runtime-stores')

        expect(stores).toMatchObject({ status: 'warn', advisory: true, evidence: 'manifest' })
        expect(stores!.message).toContain('no session store configured')
        expect(stores!.suggestion).toContain('guren add session')
        expect(gatingResults(report).map((result) => result.key)).not.toContain('deploy-runtime-stores')
      },
    )
  })

  it('keeps the unverified verdicts of a run that does not introspect out of the gate', async () => {
    await withApp('guren-check-deploy-in-process-', { 'src/app.ts': SESSION_APP }, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const report = await runCheck({ cwd: dir })
      const unverified = report.checks.filter((result) => result.key.endsWith('-unverified'))

      expect(unverified.map((result) => result.key)).toEqual(['deploy-password-hashing-unverified', 'deploy-runtime-stores-unverified'])
      for (const result of unverified) expect(result).toMatchObject({ status: 'warn', advisory: true, evidence: 'none' })
      expect(gatingResults(report).filter((result) => result.key.startsWith('deploy-'))).toEqual([])
    })
  })

  it('emits no deploy verdict for an app with no deploy target', async () => {
    await withApp('guren-check-deploy-plain-', { 'src/app.ts': SESSION_APP }, {}, async (dir) => {
      const report = await runCheck({ cwd: dir })

      expect(report.checks.filter((result) => result.key.startsWith('deploy-'))).toEqual([])
    })
  })

  it('runs under --changed when only package.json moved, and not when nothing relevant did', async () => {
    await withApp(
      'guren-check-deploy-changed-',
      { 'src/app.ts': SESSION_APP },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const manifestOnly = await runCheck({ cwd: dir, changedFiles: new Set(['package.json']) })
        expect(manifestOnly.checks.some((result) => result.key.startsWith('deploy-runtime-stores'))).toBe(true)

        const unrelated = await runCheck({ cwd: dir, changedFiles: new Set(['README.md']) })
        expect(unrelated.checks.some((result) => result.key.startsWith('deploy-'))).toBe(false)
      },
    )
  })
})

const SCRYPT_USERS = {
  users: { kind: 'model', model: 'User', hasher: 'DefaultHasher', algorithm: 'scrypt', requiresBun: false },
} as const

describe('deploy-runtime verdicts over a manifest (RFC 0026 §5)', () => {
  let base: DeployRuntimeAnalysis
  let workspace: Awaited<ReturnType<typeof createTempWorkspace>>

  beforeAll(async () => {
    // The static half (targets, OAuth, explicit constructions) of a Cloudflare app with nothing in it.
    workspace = await createTempWorkspace('guren-deploy-manifest-')
    await writeApp(workspace.dir, { 'src/app.ts': 'export {}\n' }, { '@guren/plugin-cloudflare': '^0.2.0' })
    base = await readDeployRuntime(workspace.dir)
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  function judge(
    manifest: AppManifest,
    extra: Partial<DeployRuntimeAnalysis> = {},
    drivers: ReadonlyMap<string, boolean> = BUILT_IN_SESSION_DRIVERS,
  ): Record<string, DeployRuntimeVerdict> {
    const analysis = { ...base, ...extra, manifest: readDeployManifestFacts(manifest, drivers) }
    return Object.fromEntries(judgeDeployVerdicts(analysis).map((verdict) => [verdict.key, verdict]))
  }

  it('passes password hashing on the hashers the auth manager holds, even with no auth.attempt() in source', () => {
    const hashing = judge(manifestFixture({ auth: { ...manifestFixture().auth!, providers: { ...SCRYPT_USERS } } }))['deploy-password-hashing']

    expect(hashing.status).toBe('pass')
    expect(hashing.evidence).toBe('manifest')
    expect(hashing.message).toContain("user provider 'users': DefaultHasher (scrypt)")
  })

  it('warns on a Bun-only hasher the app registers', () => {
    const hashing = judge(
      manifestFixture({
        auth: {
          ...manifestFixture().auth!,
          providers: { users: { kind: 'model', model: 'User', hasher: 'ScryptHasher', algorithm: 'argon2', requiresBun: true } },
        },
      }),
    )['deploy-password-hashing']

    expect(hashing.status).toBe('warn')
    expect(hashing.message).toContain("a Bun-only hasher is registered (user provider 'users': ScryptHasher (argon2))")
    expect(hashing.fix).toContain("Drop `hasher: 'argon2'`")
  })

  it('never passes a hasher whose format the manifest cannot tell', () => {
    const hashing = judge(
      manifestFixture({
        auth: { ...manifestFixture().auth!, providers: { api: { kind: 'custom', hasher: null, algorithm: null, requiresBun: null } } },
      }),
    )['deploy-password-hashing']

    expect(hashing.status).toBe('warn')
    expect(hashing.evidence).toBe('manifest')
    expect(hashing.message).toContain("user provider 'api': custom")
  })

  it('cannot vouch for hashing when no user provider is registered but the source verifies passwords', () => {
    // A useModel() in a provider's boot() is past the register stage the manifest describes.
    const attempt = { symbol: 'auth.attempt', filePath: 'app/Http/Controllers/LoginController.ts', line: 4 }
    const hashing = judge(manifestFixture(), { passwordAuthSignals: [attempt] })['deploy-password-hashing-unverified']

    expect(hashing).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(hashing!.message).toContain('auth.attempt (app/Http/Controllers/LoginController.ts:4)')
    expect(hashing!.evidenceReason).toContain("a useModel() in a provider's boot()")
    expect(judge(manifestFixture())['deploy-password-hashing']).toMatchObject({ status: 'pass', evidence: 'manifest' })
  })

  it('reports hashing and the stores unverified after a provider threw, still naming what the source shows', () => {
    const threw = manifestFixture({
      providers: [{ name: 'AuthProvider', source: 'options.providers', deferred: false, provides: [], register: 'threw', error: 'no binding' }],
    })
    const verdicts = judge(threw, { oauthSignals: [{ symbol: 'OAuthServiceProvider', filePath: 'src/app.ts', line: 4 }] })

    expect(Object.keys(verdicts)).toEqual(['deploy-password-hashing-unverified', 'deploy-runtime-stores-unverified', 'deploy-provider-discovery'])
    expect(verdicts['deploy-password-hashing-unverified']).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(verdicts['deploy-password-hashing-unverified']!.evidenceReason).toContain('AuthProvider threw in register()')

    const stores = verdicts['deploy-runtime-stores-unverified']!
    expect(stores).toMatchObject({ status: 'warn', evidence: 'none' })
    // One reason for both stores, stated once.
    expect(stores.message).toContain('whether the session and cache stores are per-process is unverified: AuthProvider threw in register(), so what it configures is unknown;')
    expect(stores.message).toContain('beyond that, OAuth is configured (OAuthServiceProvider (src/app.ts:4))')
    expect(stores.fix).toContain('DatabaseOAuthStateStore')
    expect(verdicts['deploy-provider-discovery']!.evidence).toBe('static')
  })

  it('cannot vouch for a session a deferred provider supplies, or one bound without describe()', () => {
    const deferred = judge(
      manifestFixture({
        providers: [{ name: 'SessionProvider', source: 'options.providers', deferred: true, provides: ['session'], register: 'skipped' }],
      }),
    )['deploy-runtime-stores-unverified']
    expect(deferred).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(deferred!.message).toContain('whether the session store is per-process is unverified: "session" is supplied by the deferred SessionProvider')

    const opaque = judge(manifestFixture({ bindings: ['app', 'auth', 'session'] }))['deploy-runtime-stores-unverified']
    expect(opaque!.message).toContain('"session" is bound, but the introspected app could not describe it')
  })

  it('never reads a config left unbound for an unset env key as absent (RFC 0027 config-unverified)', () => {
    const unset = (key?: string): AppManifest =>
      manifestFixture({
        warnings: [
          {
            code: 'config-unverified',
            message: 'the "session" config reads SESSION_DRIVER, which the environment does not set; it was left unbound.',
            provider: 'ConfigServiceProvider',
            ...(key === undefined ? {} : { key }),
          },
        ],
      })

    const session = judge(unset('session'))['deploy-runtime-stores-unverified']
    expect(session).toMatchObject({ status: 'warn', evidence: 'none' })
    expect(session!.message).toContain('whether the session store is per-process is unverified')
    expect(session!.message).toContain('reads SESSION_DRIVER, which the environment does not set')

    const cache = judge(unset('cache'))
    expect(cache['deploy-runtime-stores-unverified']!.message).toContain('whether the cache store is per-process is unverified')
    // Another key's warning says nothing about these sections.
    expect(judge(unset('mail'))['deploy-runtime-stores']).toMatchObject({ status: 'pass', evidence: 'manifest' })
    // An older server's warning names no key, so it may be any section.
    expect(judge(unset())['deploy-runtime-stores-unverified']).toBeDefined()
  })

  it('warns on a per-process session default and passes a shared one', () => {
    const session = (store: string): AppManifest['session'] => ({
      source: 'manager',
      default: store,
      stores: {
        memory: { driver: 'memory', perProcess: true },
        database: { driver: 'database', table: 'sessions', perProcess: false },
      },
    })

    const memory = judge(manifestFixture({ session: session('memory') }))['deploy-runtime-stores']
    expect(memory.status).toBe('warn')
    expect(memory.message).toContain("the 'memory' session store (driver `memory`) in this environment, which is per-process")

    const database = judge(manifestFixture({ session: session('database') }))['deploy-runtime-stores']
    expect(database).toMatchObject({ status: 'pass', evidence: 'manifest' })
  })

  it('warns on sessions with no store configured', () => {
    const stores = judge(
      manifestFixture({ session: { source: 'none', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } } }),
    )['deploy-runtime-stores']

    expect(stores.status).toBe('warn')
    expect(stores.message).toContain('no session store configured')
  })

  it("reads a plugin's session driver from its installed manifest, and cannot vouch for an undeclared one", () => {
    const kv = manifestFixture({ session: { source: 'manager', default: 'kv', stores: { kv: { driver: 'kv', perProcess: null } } } })

    expect(judge(kv, {}, new Map([...BUILT_IN_SESSION_DRIVERS, ['kv', true]]))['deploy-runtime-stores'].status).toBe('pass')
    const unknown = judge(kv)['deploy-runtime-stores']
    expect(unknown.status).toBe('warn')
    expect(unknown.fix).toContain('gurenPlugin.drivers.session')
  })

  it('cannot vouch for a SessionStore of the app’s own passed as auth.sessionOptions.store', () => {
    const stores = judge(
      manifestFixture({
        session: {
          source: 'auth.sessionOptions.store',
          default: 'sessionOptions.store',
          stores: { 'sessionOptions.store': { driver: 'KvSessionStore', perProcess: null } },
        },
      }),
    )['deploy-runtime-stores']

    expect(stores.status).toBe('warn')
    expect(stores.message).toContain('auth.sessionOptions.store (KvSessionStore), a store class this check cannot vouch for')
    // A store class is not a driver name, so no plugin manifest can vouch for it.
    expect(stores.fix).not.toContain('gurenPlugin')
    expect(
      judge(
        manifestFixture({
          session: {
            source: 'auth.sessionOptions.store',
            default: 'sessionOptions.store',
            stores: { 'sessionOptions.store': { driver: 'KvSessionStore', perProcess: null } },
          },
        }),
        {},
        new Map([...BUILT_IN_SESSION_DRIVERS, ['KvSessionStore', true]]),
      )['deploy-runtime-stores'].status,
    ).toBe('warn')
  })

  it('names a default that no store declares as the misconfiguration it is', () => {
    const stores = judge(
      manifestFixture({ session: { source: 'manager', default: 'redis', stores: { memory: { driver: 'memory', perProcess: true } } } }),
    )['deploy-runtime-stores']

    expect(stores.message).toContain("the session config's `default` names 'redis', a store it does not declare")
    expect(stores.fix).toContain('Declare the store under `stores`')
  })

  it('keeps a hand-mounted createSessionMiddleware on the scan when the manifest has no session', () => {
    const manual = { symbol: 'createSessionMiddleware', filePath: 'src/app.ts', line: 8 }

    const unbacked = judge(manifestFixture(), { sessionSignals: [manual] })['deploy-runtime-stores']
    expect(unbacked.status).toBe('warn')
    expect(unbacked.message).toContain('sessions are enabled (createSessionMiddleware (src/app.ts:8)) with no persistent store')

    const backed = { symbol: 'DatabaseSessionStore', filePath: 'src/app.ts', line: 7 }
    expect(judge(manifestFixture(), { sessionSignals: [manual], backedSessionSignals: [backed] })['deploy-runtime-stores'].status).toBe('pass')
  })

  it('honours autoSession: false beside a per-process session in the manifest', () => {
    const memory = manifestFixture({ session: { source: 'manager', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } } })
    const disabled = { symbol: 'autoSession: false', filePath: 'src/app.ts', line: 4 }

    expect(judge(memory)['deploy-runtime-stores'].status).toBe('warn')
    expect(judge(memory, { sessionDisabledSignals: [disabled] })['deploy-runtime-stores']).toMatchObject({ status: 'pass', evidence: 'manifest' })
  })

  it('judges an auth.sessionOptions.store factory by the stores the source constructs', () => {
    const backed = { symbol: 'DatabaseSessionStore', filePath: 'src/app.ts', line: 5 }
    const option = { symbol: 'sessionOptions', filePath: 'src/app.ts', line: 5 }

    expect(judge(FACTORY_SESSION, { sessionSignals: [option], backedSessionSignals: [backed] })['deploy-runtime-stores']).toMatchObject({
      status: 'pass',
      evidence: 'static',
    })
    expect(judge(FACTORY_SESSION, { sessionSignals: [option] })['deploy-runtime-stores']!.message).toContain(
      'with an auth.sessionOptions.store factory, and no DatabaseSessionStore or RedisSessionStore is constructed',
    )
  })

  it('warns on a memory cache default, which the source scan never read', () => {
    const cache = (driver: string): AppManifest['cache'] => ({ default: 'main', entries: { main: { driver } } })

    expect(judge(manifestFixture({ cache: cache('memory') }))['deploy-runtime-stores'].message).toContain(
      "the cache uses the 'main' cache store (driver `memory`)",
    )
    expect(judge(manifestFixture({ cache: cache('redis') }))['deploy-runtime-stores'].status).toBe('pass')
  })

  it('lets the manifest, not a MemorySessionStore construction, name the session store', () => {
    const signal = { symbol: 'MemorySessionStore', filePath: 'tests/support/session.ts', line: 3 }
    const shared = manifestFixture({
      session: { source: 'manager', default: 'database', stores: { database: { driver: 'database', perProcess: false } } },
    })

    expect(judge(shared, { memoryStoreSignals: [signal] })['deploy-runtime-stores'].status).toBe('pass')
    // With no session in the manifest, the construction is all there is to go on.
    expect(judge(manifestFixture(), { memoryStoreSignals: [signal] })['deploy-runtime-stores'].status).toBe('warn')
  })

  it('keeps OAuth state and explicit memory constructions on the scan, which the manifest does not carry', () => {
    const stores = judge(manifestFixture(), {
      oauthSignals: [{ symbol: 'OAuthServiceProvider', filePath: 'src/app.ts', line: 4 }],
      memoryStoreSignals: [{ symbol: 'MemoryRateLimitStore', filePath: 'app/limit.ts', line: 9 }],
    })['deploy-runtime-stores']

    expect(stores.status).toBe('warn')
    expect(stores.message).toContain('MemoryRateLimitStore (app/limit.ts:9)')
    expect(stores.message).toContain('OAuth is configured')
    expect(stores.evidence).toBe('manifest')
  })

  it('judges provider discovery from source, since a discovered provider registers as app.register', () => {
    const discovery = judge(
      manifestFixture({
        providers: [{ name: 'MailProvider', source: 'app.register', deferred: false, provides: [], register: 'ran' }],
      }),
      { discoverySignals: [{ symbol: 'AutoDiscovery', filePath: 'src/app.ts', line: 7 }] },
    )['deploy-provider-discovery']

    expect(discovery).toMatchObject({ status: 'warn', evidence: 'static' })
    expect(judge(manifestFixture())['deploy-provider-discovery'].status).toBe('pass')
  })
})
