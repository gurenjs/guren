import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { runBlueprint } from '../src/blueprints'
import { runCheck, type CheckResult } from '../src/check'
import {
  assertWorkspaceBuilt,
  captureWarnings,
  CONSOLE_FIXTURE,
  createTempRoot,
  DEFAULT_ROUTES_FIXTURE,
  linkWorkspaceCore,
  linkWorkspacePackage,
  PG_SCHEMA_FIXTURE,
  SERVER_DIST_ENTRY,
  SESSION_PROVIDER,
  writeWorkspaceFiles,
} from './helpers'

const ENTRY = "import app from './app.js'\n\nexport default app\n"

/** No deploy plugin: the session and attachments rules are what start the introspection here. */
const APP = `import { createApp } from '@guren/core'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  auth: {},
  routes: registerWebRoutes,
  providers: [],
})

export default app
`

const ATTACHABLE_MODEL = `import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends Attachable(defineModel(users), {
  avatar: hasOneAttached(),
}) {}
`

const THROWING_PROVIDER = `import { ServiceProvider } from '@guren/core'

export default class BindingProvider extends ServiceProvider {
  register(): void {
    throw new Error('env.DB is not bound outside workerd')
  }
}
`

let root: string

/**
 * `guren add session` / `guren add attachments` over a fresh app, one directory per scenario:
 * `introspectApp()` memoises per app root for the whole test process.
 */
async function scaffoldApp(
  name: string,
  blueprints: Array<'session' | 'attachments'>,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, name)
  await linkWorkspaceCore(dir)
  await linkWorkspacePackage('orm', dir)
  await writeWorkspaceFiles(dir, {
    // Bun otherwise installs an unresolvable specifier from npm instead of failing.
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'package.json': JSON.stringify({ name, type: 'module' }),
    'src/main.ts': ENTRY,
    'src/app.ts': APP,
    'src/console.ts': CONSOLE_FIXTURE,
    'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
    'db/schema.ts': PG_SCHEMA_FIXTURE,
  })

  const previous = process.cwd()
  process.chdir(dir)
  try {
    await captureWarnings(async () => {
      for (const blueprint of blueprints) await runBlueprint(blueprint, {})
    })
  } finally {
    process.chdir(previous)
  }

  await writeWorkspaceFiles(dir, files)
  return dir
}

function wiring(checks: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(
    checks.filter((result) => /^(sessions-|attachments-|introspection-)/.test(result.key)).map((result) => [result.key, result]),
  )
}

async function bothWays(dir: string): Promise<{ manifest: Record<string, CheckResult>; source: Record<string, CheckResult> }> {
  const manifest = wiring((await runCheck({ cwd: dir, introspect: true })).checks)
  const source = wiring((await runCheck({ cwd: dir, introspect: false })).checks)
  return { manifest, source }
}

beforeAll(async () => {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  root = await createTempRoot('guren-wiring-introspect-test-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('session and attachments wiring read from the introspected app (RFC 0026 §5)', () => {
  test('agrees with the source reading on a scaffolded app, and says it read the manifest', async () => {
    const dir = await scaffoldApp('scaffolded', ['session', 'attachments'], { 'app/Models/User.ts': ATTACHABLE_MODEL })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['introspection-unavailable']).toBeUndefined()
    expect(Object.keys(manifest).sort()).toEqual([
      'attachments-config:config/attachments.ts',
      'attachments-delivery',
      'attachments-model:app/Models/User.ts',
      'attachments-public-disk:config/attachments.ts:local',
      'sessions-binding',
      'sessions-config:config/session.ts:sessions',
    ])
    expect(Object.keys(source).sort()).toEqual(Object.keys(manifest).sort())

    for (const [key, result] of Object.entries(manifest)) {
      expect({ key, status: result.status }).toEqual({ key, status: source[key]!.status })
      expect(result.status).toBe('pass')
      // The disk's root is read from source whichever way the disk was found.
      expect({ key, evidence: result.evidence }).toEqual({ key, evidence: key.startsWith('attachments-public-disk:') ? 'static' : 'manifest' })
      expect({ key, evidence: source[key]!.evidence }).toEqual({ key, evidence: 'static' })
    }
  })

  test('reports a session config no provider registers from `source: none`, under the key the scan uses', async () => {
    const dir = await scaffoldApp('inert-session', ['session'], { 'src/app.ts': APP })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['sessions-binding']!.message).toContain("binds no 'session' in register()")
    expect(manifest['sessions-binding']!.message).toContain('in-memory default')
    expect(source['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'static' })
    expect(source['sessions-binding']!.message).toContain('createApp() does not register it')
  })

  test('warns on a binding provider the entry imports but never registers, which the scan passed', async () => {
    const dir = await scaffoldApp('imported-not-registered', ['session'], {
      'src/app.ts': `import SessionProvider from '../app/Providers/SessionProvider.js'\n${APP}\nexport { SessionProvider }\n`,
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(source['sessions-binding']).toMatchObject({ status: 'pass', evidence: 'static' })
  })

  test('fails a database store whose table object the schema does not declare, which the scan cannot follow', async () => {
    const dir = await scaffoldApp('table-outside-schema', [], {
      'config/session.ts': `import { type SessionConfig } from '@guren/core'
import { jsonb, pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

const sessions = pgTable('legacy_sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const sessionConfig: SessionConfig = {
  default: 'database',
  stores: { database: { driver: 'database', table: sessions } },
}
`,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP.replace("import registerWebRoutes", "import SessionProvider from '../app/Providers/SessionProvider.js'\nimport registerWebRoutes")
        .replace('providers: []', 'providers: [SessionProvider]'),
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['sessions-config:config/session.ts:sessions']).toMatchObject({ status: 'fail', evidence: 'manifest', filePath: 'config/session.ts' })
    expect(manifest['sessions-config:config/session.ts:sessions']!.message).toContain("'legacy_sessions'")
    expect(manifest['sessions-binding']).toMatchObject({ status: 'pass', evidence: 'manifest' })
    expect(source['sessions-config:config/session.ts:sessions']).toBeUndefined()
  })

  test('fails an unmounted delivery route and a redirect disk that cannot presign, from the engine and the storage manager', async () => {
    const dir = await scaffoldApp('delivery', ['attachments'])
    const config = await Bun.file(join(dir, 'config/attachments.ts')).text()
    await writeWorkspaceFiles(dir, {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'config/attachments.ts': config.replace(
        "disks: { local: 'private', public: 'public' }",
        "disks: { local: { visibility: 'private', serve: 'redirect' }, public: 'public' }",
      ),
    })
    const { manifest, source } = await bothWays(dir)

    for (const key of ['attachments-delivery:config/attachments.ts', 'attachments-serve-redirect:config/attachments.ts:local']) {
      expect({ key, ...manifest[key] }).toMatchObject({ key, status: 'fail', evidence: 'manifest' })
      expect({ key, ...source[key] }).toMatchObject({ key, status: 'fail', evidence: 'static' })
    }
    expect(manifest['attachments-delivery:config/attachments.ts']!.message).toContain("no registerAttachmentRoutes() route named 'attachments.show'")
    expect(manifest['attachments-delivery']).toBeUndefined()
  })

  test('does not take an app route carrying the delivery route name for the mount', async () => {
    const dir = await scaffoldApp('delivery-name-only', ['attachments'])
    await writeWorkspaceFiles(dir, {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE.replace(
        "router.get('/', () => 'home')",
        "router.get('/', () => 'home')\n  router.get('/files/:id', () => 'file').name('attachments.show')",
      ),
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['attachments-delivery:config/attachments.ts']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(source['attachments-delivery:config/attachments.ts']).toMatchObject({ status: 'fail', evidence: 'static' })
  })

  test('judges a model from source when configureAttachments() runs only in boot(), past what introspection runs', async () => {
    const dir = await scaffoldApp('configured-in-boot', [], {
      'app/Models/User.ts': ATTACHABLE_MODEL,
      'app/Providers/AttachmentsProvider.ts': `import { configureAttachments, ServiceProvider } from '@guren/core'
import { users } from '../../db/schema.js'

export default class AttachmentsProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    configureAttachments({ table: users, storage: () => ({}) as never, disk: 'local' })
  }
}
`,
      'src/app.ts': APP.replace("import registerWebRoutes", "import AttachmentsProvider from '../app/Providers/AttachmentsProvider.js'\nimport registerWebRoutes")
        .replace('providers: []', 'providers: [AttachmentsProvider]'),
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['attachments-model:app/Models/User.ts']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['attachments-model:app/Models/User.ts']!.message).toContain("a call in a provider's boot()")
  })

  test('reads the disk an environment variable selects, which the scan cannot', async () => {
    const dir = await scaffoldApp('env-disk', ['attachments'], { '.env': 'RFC26_ATTACHMENTS_DISK=public\n' })
    const config = await Bun.file(join(dir, 'config/attachments.ts')).text()
    await writeWorkspaceFiles(dir, {
      'config/attachments.ts': config.replace("disk: 'local',", "disk: process.env.RFC26_ATTACHMENTS_DISK || 'local',"),
    })
    const { manifest, source } = await bothWays(dir)

    // The disk comes from the engine; its root, under public/, from source.
    expect(manifest['attachments-public-disk:config/attachments.ts:public']).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(Object.keys(source).filter((key) => key.startsWith('attachments-public-disk:'))).toEqual([])
  })

  test('names auth.sessionOptions.store as why the session config is never read', async () => {
    const dir = await scaffoldApp('session-options-store', ['session'], {
      'src/app.ts': APP.replace("import { createApp } from '@guren/core'", "import { createApp, MemorySessionStore } from '@guren/core'")
        .replace('auth: {},', 'auth: { sessionOptions: { store: new MemorySessionStore() } },'),
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['sessions-binding']!.message).toContain('sessionOptions: { store }')
  })

  test('judges a session config left unbound for an unset env key from source, and says so', async () => {
    const dir = await scaffoldApp('unset-env', [], {
      'db/schema.ts': `${PG_SCHEMA_FIXTURE}
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
`,
      'config/session.ts': `import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

export default defineSessionConfig((values) => ({
  default: (values as unknown as Record<string, string>).RFC26_UNSET_SESSION_DRIVER,
  stores: { database: { driver: 'database', table: sessions } },
}))
`,
      'src/app.ts': `import { createApp, defineEnv, Env } from '@guren/core'
import session from '../config/session.js'
import registerWebRoutes from '../routes/web.js'

const env = defineEnv({ RFC26_UNSET_SESSION_DRIVER: Env.string() })

export default createApp({ env, config: [session], auth: {}, routes: registerWebRoutes })
`,
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['sessions-config:config/session.ts:sessions']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['sessions-config:config/session.ts:sessions']!.message).toContain('Judged from source:')
    expect(manifest['sessions-config:config/session.ts:sessions']!.message).toContain('RFC26_UNSET_SESSION_DRIVER')
    expect(manifest['sessions-binding']).toBeUndefined()
  })

  test('falls back to the scan after a provider threw', async () => {
    const dir = await scaffoldApp('threw', ['session', 'attachments'], { 'app/Providers/BindingProvider.ts': THROWING_PROVIDER })
    const app = await Bun.file(join(dir, 'src/app.ts')).text()
    await writeWorkspaceFiles(dir, {
      'src/app.ts': `import BindingProvider from '../app/Providers/BindingProvider.js'\n${app.replace('providers: [', 'providers: [BindingProvider, ')}`,
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['introspection-unavailable']).toBeUndefined()
    for (const key of ['sessions-binding', 'sessions-config:config/session.ts:sessions', 'attachments-config:config/attachments.ts', 'attachments-delivery']) {
      expect({ key, ...manifest[key] }).toMatchObject({ key, status: source[key]!.status, evidence: 'static' })
      expect(manifest[key]!.message).toContain('Judged from source: BindingProvider threw in register()')
    }
  })

  test('introspects an app with no deploy target once it has a session config, and falls back when that fails', async () => {
    const dir = await scaffoldApp('broken-entry', ['session'], {
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['introspection-unavailable']).toMatchObject({ status: 'warn', advisory: true })
    expect(manifest['introspection-unavailable']!.message).toContain('(import)')
    expect(manifest['sessions-binding']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['sessions-config:config/session.ts:sessions']).toMatchObject({ status: 'pass', evidence: 'static' })
  })

  test('does not introspect an app with no session or attachments config', async () => {
    const dir = await scaffoldApp('no-wiring', [], {
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })

    const { manifest } = await bothWays(dir)
    expect(manifest).toEqual({})
  })
})
