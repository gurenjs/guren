import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { analyzeDeployRuntime } from '../src/deploy-runtime'
import { buildJsonOutput, getDoctorRuleEvaluations, runDoctor } from '../src/doctor'
import type { DoctorCheck, DoctorStatus } from '../src/doctor'
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

type DeployCheckKey = (typeof DEPLOY_CHECK_KEYS)[number]

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

/** The three deploy checks, keyed for direct assertion. */
async function deployChecks(cwd: string): Promise<Record<DeployCheckKey, DoctorCheck>> {
  const { evaluations } = await getDoctorRuleEvaluations({ cwd })
  const found = {} as Record<DeployCheckKey, DoctorCheck>

  for (const key of DEPLOY_CHECK_KEYS) {
    const check = evaluations.find((evaluation) => evaluation.check.key === key)?.check
    if (!check) {
      throw new Error(`doctor did not emit a "${key}" check`)
    }
    found[key] = check
  }

  return found
}

function statuses(checks: Record<DeployCheckKey, DoctorCheck>): Record<DeployCheckKey, DoctorStatus> {
  return {
    'deploy-password-hashing': checks['deploy-password-hashing'].status,
    'deploy-runtime-stores': checks['deploy-runtime-stores'].status,
    'deploy-provider-discovery': checks['deploy-provider-discovery'].status,
  }
}

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
const OAUTH_ONLY_AUTH = `import { AuthenticatableModel, ServiceProvider } from '@guren/core'
export class User extends AuthenticatableModel {
  static guarded = ['id', 'passwordHash', 'rememberToken']
}
export default class AuthProvider extends ServiceProvider {
  register() {
    // passwordColumn stays configured so the guard rejects password logins
    // for hash-less OAuth accounts.
    auth.useModel(User, { usernameColumn: 'email', passwordColumn: 'passwordHash' })
  }
}
`

const SESSION_APP = `import { createApp } from '@guren/core'
export const app = createApp({ auth: { autoSession: true } })
`

describe('deploy target detection', () => {
  it('detects the Cloudflare plugin from package.json dependencies', async () => {
    await withApp('guren-deploy-cf-', {}, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.id).toBe('cloudflare')
      expect(targets[0].detectedVia).toContain('@guren/plugin-cloudflare')
    })
  })

  it('detects the Vercel plugin and marks it as a Bun runtime', async () => {
    await withApp('guren-deploy-vercel-', {}, { '@guren/plugin-vercel': '^0.2.0' }, async (dir) => {
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.id).toBe('vercel')
      // buildVercelOutput emits `runtime: 'bun1.x'`, so Bun.password exists.
      expect(targets[0].profile.hasBunRuntime).toBe(true)
    })
  })

  it('detects the Lambda adapter from a @guren/core/lambda import', async () => {
    const files = {
      'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\nexport const handler = createLambdaHandler(app)\n`,
    }

    await withApp('guren-deploy-lambda-', files, {}, async (dir) => {
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets).toHaveLength(1)
      expect(targets[0].profile.id).toBe('lambda')
      expect(targets[0].detectedVia).toContain('lambda.ts')
    })
  })

  it('detects the Lambda adapter from the @guren/server/lambda path too', async () => {
    const files = {
      'src/lambda.ts': `import { createLambdaHandler } from '@guren/server/lambda'\n`,
    }

    await withApp('guren-deploy-lambda-server-', files, {}, async (dir) => {
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets.map((target) => target.profile.id)).toEqual(['lambda'])
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
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets.map((target) => target.profile.id)).toEqual(['lambda'])
    })
  })

  it('detects several targets at once', async () => {
    const files = { 'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\n` }
    const deps = { '@guren/plugin-cloudflare': '^0.2.0' }

    await withApp('guren-deploy-multi-', files, deps, async (dir) => {
      const { targets } = await analyzeDeployRuntime(dir)

      expect(targets.map((target) => target.profile.id).sort()).toEqual(['cloudflare', 'lambda'])
    })
  })

  it('reports no target for a plain Bun app', async () => {
    await withApp('guren-deploy-none-', { 'src/app.ts': SESSION_APP }, {}, async (dir) => {
      expect((await analyzeDeployRuntime(dir)).targets).toEqual([])
    })
  })
})

describe('deploy-password-hashing check', () => {
  it('warns when a Workers app verifies passwords without NodeHasher', async () => {
    const files = { 'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER }

    await withApp('guren-hash-cf-warn-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('Cloudflare Workers')
      expect(check.message).toContain('auth.attempt (app/Http/Controllers/LoginController.ts:4)')
      expect(check.fix).toContain('NodeHasher')
    })
  })

  it('warns for Lambda as well', async () => {
    const files = {
      'lambda.ts': `import { createLambdaHandler } from '@guren/core/lambda'\n`,
      'db/seeders/001_UsersSeeder.ts': `import { ScryptHasher } from '@guren/core'\nconst hasher = new ScryptHasher()\n`,
    }

    await withApp('guren-hash-lambda-warn-', files, {}, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('AWS Lambda')
      expect(check.message).toContain('ScryptHasher')
    })
  })

  // A bare import is not remediation: the check must see the hasher actually
  // constructed, or a leftover `import { NodeHasher }` would silence a real gap.
  it('still warns when NodeHasher is imported but never constructed', async () => {
    const files = {
      'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER,
      'app/Models/User.ts': `import { AuthenticatableModel, NodeHasher } from '@guren/core'
export class User extends AuthenticatableModel {}
`,
    }

    await withApp('guren-hash-import-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('warn')
    })
  })

  it('passes once NodeHasher is configured', async () => {
    const files = {
      'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER,
      'app/Models/User.ts': `import { AuthenticatableModel, NodeHasher } from '@guren/core'
export class User extends AuthenticatableModel {
  protected static passwordHasher = new NodeHasher()
}
`,
    }

    await withApp('guren-hash-cf-pass-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('NodeHasher is configured')
    })
  })

  it('passes for an OAuth-only app with no password authentication', async () => {
    const files = { 'src/app.ts': SESSION_APP }

    await withApp('guren-hash-oauth-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('no password authentication')
    })
  })

  // Regression: guren.dev is an OAuth-only Workers app that keeps
  // AuthenticatableModel and passwordColumn so the guard can reject password
  // logins for hash-less accounts. Treating those as password auth reported a
  // break that cannot happen.
  it('does not warn for a passwordless app that still configures passwordColumn', async () => {
    const files = { 'app/Providers/AuthProvider.ts': OAUTH_ONLY_AUTH }

    await withApp('guren-hash-passwordless-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-password-hashing']

      expect(check.status).toBe('pass')
      expect(check.message).toContain('no password authentication')
    })
  })

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
  it('warns when sessions are enabled with no backed store', async () => {
    await withApp(
      'guren-stores-session-',
      { 'src/app.ts': SESSION_APP },
      { '@guren/plugin-cloudflare': '^0.2.0' },
      async (dir) => {
        const check = (await deployChecks(dir))['deploy-runtime-stores']

        expect(check.status).toBe('warn')
        expect(check.message).toContain('sessions are enabled')
        expect(check.message).toContain('DatabaseSessionStore')
        expect(check.fix).toContain('DatabaseSessionStore')
      },
    )
  })

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
      const check = (await deployChecks(dir))['deploy-runtime-stores']

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
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  // The `auth: {` match alone can't see what's inside the object it opens, so
  // suppression must come from a whole-app check for `autoSession: false`,
  // not from excluding it within the same regex pass (that reintroduces the
  // exact backtracking bug fixed above).
  it('does not warn when autoSession: false sits inside the same auth: { line', async () => {
    const files = {
      'src/app.ts': `import { createApp } from '@guren/core'
export const app = createApp({ auth: { autoSession: false } })
`,
    }

    await withApp('guren-stores-bare-auth-disabled-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
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
      const check = (await deployChecks(dir))['deploy-runtime-stores']

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
      const check = (await deployChecks(dir))['deploy-runtime-stores']

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
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
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
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
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
    })
  })

  // Without these the whole BACKED_OAUTH_PATTERNS table could be broken and
  // every other test would still pass — a correctly-configured OAuth app would
  // then be warned at, the exact false positive this check exists to avoid.
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

  // A bare import is not active use — it survives refactors that drop the
  // actual discovery call, the same false positive fixed for NodeHasher.
  it('does not warn on an AutoDiscovery import that is never constructed', async () => {
    const files = { 'src/app.ts': `import { AutoDiscovery } from '@guren/core'\n` }

    await withApp('guren-discovery-import-only-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-provider-discovery'].status).toBe('pass')
    })
  })

  // ApplicationOptions.discover is declared but never read anywhere in
  // @guren/server, so it has no runtime effect — writing `discover: true`
  // does not activate filesystem provider discovery and must not warn.
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
      const deployEvaluations = evaluations.filter((evaluation) =>
        (DEPLOY_CHECK_KEYS as readonly string[]).includes(evaluation.check.key),
      )

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
      const report = await runDoctor({ cwd: dir, json: true, next: true })
      const json = buildJsonOutput(report)
      const byKey = new Map(json.checks.map((check) => [check.key, check]))

      for (const key of DEPLOY_CHECK_KEYS) {
        expect(byKey.has(key)).toBe(true)
      }

      // The session default is unaddressed here, so it must reach the operator
      // as a warning with manual remediation and no autofix offer.
      const stores = byKey.get('deploy-runtime-stores')
      expect(stores?.status).toBe('warn')
      expect(stores?.canAutofix).toBe(false)
      expect(stores?.manualFix).toContain('DatabaseSessionStore')

      expect(report.hasWarnings).toBe(true)
      expect(report.manualChecks.map((check) => check.key)).toContain('deploy-runtime-stores')
      expect(report.fixableChecks.map((check) => check.key)).not.toContain('deploy-runtime-stores')
      expect(json.summary.total).toBe(json.checks.length)
      expect(Array.isArray(json.nextSteps)).toBe(true)
    })
  })
})

describe('AST-based matching', () => {
  // The regex generation of this scanner documented aliased imports as a
  // known gap in both directions. The AST resolves them, so an aliased
  // remediation must count and an aliased hazard must still warn.
  it('recognizes an aliased NodeHasher construction as remediation', async () => {
    const files = {
      'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER,
      'app/Models/User.ts': `import { AuthenticatableModel, NodeHasher as RuntimeHasher } from '@guren/core'
export class User extends AuthenticatableModel {
  protected static passwordHasher = new RuntimeHasher()
}
`,
    }

    await withApp('guren-ast-alias-hasher-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-password-hashing'].status).toBe('pass')
    })
  })

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
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
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
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
    })
  })

  it('ignores constructions inside comments and string literals', async () => {
    const files = {
      'src/notes.ts': `// migration note: replace new MemoryStore() before deploying
export const doc = 'call new MemoryDriver() to enqueue locally'
`,
    }

    await withApp('guren-ast-comments-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await analyzeDeployRuntime(dir)).memoryStoreSignals).toEqual([])
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
      expect((await analyzeDeployRuntime(dir)).sessionSignals).toEqual([])
    })
  })

  // Regex-era false positive: the make:auth mail config contains
  // `auth: { user, pass }` for SMTP credentials, which has nothing to do
  // with sessions. Scoping the auth-key signal to createApp options fixes it.
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
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('pass')
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
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })

  // Resolving names bare made any same-named export satisfy a remediation.
  // An unrelated `NodeHasher` silently marked a Workers app as fixed, which is
  // the worst direction for this check: it hides a real production break.
  it('does not let a same-named import from another package satisfy the hasher remediation', async () => {
    const files = {
      'app/Http/Controllers/LoginController.ts': PASSWORD_LOGIN_CONTROLLER,
      'app/lib/hash.ts': `import { NodeHasher } from 'some-other-package'\nexport const h = new NodeHasher()\n`,
    }

    await withApp('guren-ast-foreign-hasher-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-password-hashing'].status).toBe('warn')
    })
  })

  it('does not let a same-named import from another package satisfy the store remediation', async () => {
    const files = {
      'src/app.ts': SESSION_APP,
      'src/stores.ts': `import { DatabaseSessionStore } from './my-own'\nexport const s = new DatabaseSessionStore(x)\n`,
    }

    await withApp('guren-ast-foreign-store-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      expect((await deployChecks(dir))['deploy-runtime-stores'].status).toBe('warn')
    })
  })

  // A decorator anywhere in the file used to make it unparseable, and an
  // unparseable file contributes nothing — hiding every signal it holds.
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
      expect((await analyzeDeployRuntime(dir)).oauthSignals).toEqual([])
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
      const analysis = await analyzeDeployRuntime(dir)

      expect(analysis.sessionSignals.map((s) => s.symbol)).toContain('auth')
      expect(analysis.oauthSignals.map((s) => s.symbol)).toContain('createOAuthManager')
      expect(analysis.backedSessionSignals.map((s) => s.symbol)).toContain('DatabaseSessionStore')
    })
  })

  it('skips a file that fails to parse without failing the run', async () => {
    const files = {
      'src/broken.ts': `export const = this is not valid typescript {{{`,
      'src/app.ts': SESSION_APP,
    }

    await withApp('guren-ast-broken-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      // The broken file contributes nothing; the valid one still signals.
      const check = (await deployChecks(dir))['deploy-runtime-stores']

      expect(check.status).toBe('warn')
      expect(check.message).toContain('sessions are enabled')
    })
  })
})

describe('test files are excluded from the scan', () => {
  // A test fixture constructing a backed store would otherwise satisfy the
  // remediation check on behalf of an app that never wires one up, hiding a
  // real production gap.
  it('does not let a store constructed in a test file mask a production gap', async () => {
    const files = {
      'src/app.ts': SESSION_APP,
      'src/app.test.ts': `import { DatabaseSessionStore } from '@guren/core'
const store = new DatabaseSessionStore(sessions)
`,
    }

    await withApp('guren-scan-test-mask-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const check = (await deployChecks(dir))['deploy-runtime-stores']

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
        expect((await analyzeDeployRuntime(dir)).memoryStoreSignals).toEqual([])
      })
    })
  }

  it('does not raise a session signal from a test fixture alone', async () => {
    const files = {
      'src/routes.test.ts': `const app = createApp({ auth: { autoSession: true } })\n`,
    }

    await withApp('guren-scan-test-signal-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await analyzeDeployRuntime(dir)

      expect(analysis.sessionSignals).toEqual([])
    })
  })
})

describe('analyzeDeployRuntime', () => {
  // Every entry in DEPLOY_SCAN_DIRS. Without this, dropping a directory from
  // that list — including `functions`/`api`, added for serverless entrypoint
  // layouts — would silently stop the whole scan there with no test failing.
  for (const dir of ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const) {
    it(`scans the ${dir}/ directory`, async () => {
      const files = {
        [`${dir}/probe.ts`]: `import { MemoryStore } from '@guren/core'\nexport const s = new MemoryStore()\n`,
      }

      await withApp(`guren-deploy-scan-${dir}-`, files, {}, async (workspace) => {
        const analysis = await analyzeDeployRuntime(workspace)

        expect(analysis.memoryStoreSignals.map((signal) => signal.filePath)).toContain(`${dir}/probe.ts`)
      })
    })
  }

  it('scans source files sitting directly in the project root', async () => {
    const files = { 'worker.ts': `import { MemoryStore } from '@guren/core'\nexport const s = new MemoryStore()\n` }

    await withApp('guren-deploy-scan-root-', files, {}, async (dir) => {
      const analysis = await analyzeDeployRuntime(dir)

      expect(analysis.memoryStoreSignals.map((signal) => signal.filePath)).toContain('worker.ts')
    })
  })

  it('scans modules/ trees as well as the project root', async () => {
    const files = {
      'modules/billing/index.ts': `import { MemoryStore } from '@guren/core'\nexport const store = new MemoryStore()\n`,
    }

    await withApp('guren-deploy-modules-', files, { '@guren/plugin-cloudflare': '^0.2.0' }, async (dir) => {
      const analysis = await analyzeDeployRuntime(dir)

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
      const analysis = await analyzeDeployRuntime(dir)

      expect(analysis.memoryStoreSignals).toEqual([])
    })
  })
})
