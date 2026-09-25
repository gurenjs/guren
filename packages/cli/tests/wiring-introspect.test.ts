import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { runBlueprint } from '../src/blueprints'
import { runCheck, type CheckResult } from '../src/check'
import { gatingResults } from '../src/check-result'
import { runGate, type GateExec } from '../src/gate'
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
  test('passes a scaffolded app from the manifest, and leaves what only the app shows unverified without it', async () => {
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
    for (const [key, result] of Object.entries(manifest)) {
      expect(result.status).toBe('pass')
      // The disk's root is read from source whichever way the disk was found.
      expect({ key, evidence: result.evidence }).toEqual({ key, evidence: key.startsWith('attachments-public-disk:') ? 'static' : 'manifest' })
    }

    // The binding and the mount are registered-app facts; the tables, the model and the disk root are source ones.
    expect(Object.keys(source).sort()).toEqual([
      'attachments-config:config/attachments.ts',
      'attachments-delivery-unverified:config/attachments.ts',
      'attachments-model:app/Models/User.ts',
      'attachments-public-disk:config/attachments.ts:local',
      'sessions-binding-unverified',
      'sessions-config:config/session.ts:sessions',
    ])
    for (const [key, result] of Object.entries(source)) {
      const unverified = key.includes('-unverified')
      expect({ key, status: result.status, evidence: result.evidence, advisory: result.advisory ?? false }).toEqual({
        key,
        status: unverified ? 'warn' : 'pass',
        evidence: unverified ? 'none' : 'static',
        advisory: unverified,
      })
    }
  })

  test('reports a session config no provider registers from `source: none`, under the key the scan uses', async () => {
    const dir = await scaffoldApp('inert-session', ['session'], { 'src/app.ts': APP })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['sessions-binding']!.message).toContain("binds no 'session' in register()")
    expect(manifest['sessions-binding']!.message).toContain('in-memory default')
    expect(source['sessions-binding-unverified']).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
  })

  test('warns on a binding provider the entry imports but never registers', async () => {
    const dir = await scaffoldApp('imported-not-registered', ['session'], {
      'src/app.ts': `import SessionProvider from '../app/Providers/SessionProvider.js'\n${APP}\nexport { SessionProvider }\n`,
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(source['sessions-binding']).toBeUndefined()
  })

  test('warns, advisory, on a database store whose table object no db/schema.ts declares, which the scan cannot follow', async () => {
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

    expect(manifest['sessions-config:config/session.ts:sessions']).toMatchObject({ status: 'warn', advisory: true, evidence: 'manifest', filePath: 'config/session.ts' })
    expect(manifest['sessions-config:config/session.ts:sessions']!.message).toContain("'legacy_sessions'")
    expect(manifest['sessions-binding']).toMatchObject({ status: 'pass', evidence: 'manifest' })
    expect(source['sessions-config:config/session.ts:sessions']).toBeUndefined()
  })

  test('keeps the source pass when the reader names a pgTableCreator() table without its prefix', async () => {
    const schema = `import { index, integer, jsonb, pgTableCreator, serial, text, timestamp } from '@guren/orm/drizzle/pg'
import type { AttachmentVariantRecord } from '@guren/core'

const pgTable = pgTableCreator((name) => \`app_\${name}\`)
`
    const dir = await scaffoldApp('table-creator', ['session', 'attachments'])
    const scaffolded = await Bun.file(join(dir, 'db/schema.ts')).text()
    // The scaffolded tables, declared through the prefixing factory instead of drizzle's own.
    const tables = scaffolded.slice(scaffolded.indexOf('export const users'))
    await writeWorkspaceFiles(dir, { 'db/schema.ts': `${schema}\n${tables}` })
    const report = await runCheck({ cwd: dir, introspect: true })
    const manifest = wiring(report.checks)

    expect(manifest['introspection-unavailable']).toBeUndefined()
    for (const key of ['sessions-config:config/session.ts:sessions', 'attachments-config:config/attachments.ts']) {
      expect({ ...manifest[key], key }).toMatchObject({ key, status: 'pass', evidence: 'static' })
    }
    expect(gatingResults(report).filter((result) => /^(sessions|attachments)-/.test(result.key))).toEqual([])
  })

  test('fails a bound session manager beside auth.sessionOptions.store, which the app refuses at boot', async () => {
    const dir = await scaffoldApp('configured-twice', ['session'])
    const app = await Bun.file(join(dir, 'src/app.ts')).text()
    await writeWorkspaceFiles(dir, {
      'src/app.ts': app
        .replace("import { createApp } from '@guren/core'", "import { createApp, MemorySessionStore } from '@guren/core'")
        .replace('auth: {},', 'auth: { sessionOptions: { store: new MemorySessionStore() } },'),
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['sessions-binding']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(manifest['sessions-binding']!.message).toContain('refuses to boot')
  })

  test('guren gate introspects the app itself, so its check stage fails what only the registered app shows', async () => {
    const dir = await scaffoldApp('gate-configured-twice', ['session'])
    const app = await Bun.file(join(dir, 'src/app.ts')).text()
    const pkg = JSON.parse(await Bun.file(join(dir, 'package.json')).text())
    await writeWorkspaceFiles(dir, {
      'src/app.ts': app
        .replace("import { createApp } from '@guren/core'", "import { createApp, MemorySessionStore } from '@guren/core'")
        .replace('auth: {},', 'auth: { sessionOptions: { store: new MemorySessionStore() } },'),
      'package.json': JSON.stringify({ ...pkg, scripts: { codegen: 'guren codegen', typecheck: 'tsc --noEmit', test: 'bun test' } }),
    })
    // The script stages are not under test; check and audit run in process against the real child.
    const exec: GateExec = async () => ({ exitCode: 0, stdout: '', stderr: '' })

    const report = await runGate({ cwd: dir, exec })

    const check = report.stages.find((stage) => stage.name === 'check')!
    // The faked codegen writes nothing, so the generated-file findings sit beside it.
    expect(check.status).toBe('fail')
    expect(check.findings).toContainEqual(expect.stringContaining('refuses to boot'))
    expect(report.stages.flatMap((stage) => stage.findings).some((finding) => finding.startsWith('Introspection'))).toBe(false)
  })

  test('fails a model when a module-scope configureAttachments() lives in a file nothing loads', async () => {
    const dir = await scaffoldApp('never-loaded', ['attachments'], { 'app/Models/User.ts': ATTACHABLE_MODEL })
    const app = await Bun.file(join(dir, 'src/app.ts')).text()
    await writeWorkspaceFiles(dir, {
      'src/app.ts': app.replace(/import AttachmentsProvider[^\n]*\n/, '').replace(/AttachmentsProvider,? ?/, ''),
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['attachments-model:app/Models/User.ts']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(manifest['attachments-model:app/Models/User.ts']!.message).toContain('never loads that module')
    expect(source['attachments-model:app/Models/User.ts']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['attachments-config:config/attachments.ts']!.message).toContain('never loaded config/attachments.ts')
  })

  test('judges a model from source when a provider boot() imports the config dynamically', async () => {
    const dir = await scaffoldApp('boot-dynamic-import', ['attachments'], {
      'app/Models/User.ts': ATTACHABLE_MODEL,
      'app/Providers/AttachmentsProvider.ts': `import { ServiceProvider } from '@guren/core'

export default class AttachmentsProvider extends ServiceProvider {
  register(): void {}

  async boot(): Promise<void> {
    await import('../../config/attachments.js')
  }
}
`,
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['attachments-model:app/Models/User.ts']).toMatchObject({ status: 'pass', evidence: 'static' })
    expect(manifest['attachments-model:app/Models/User.ts']!.message).toContain("a call in a provider's boot()")
  })

  test('warns, advisory, on an attachments table no db/schema.ts declares', async () => {
    const dir = await scaffoldApp('attachments-table-outside-schema', ['attachments'])
    const config = await Bun.file(join(dir, 'config/attachments.ts')).text()
    await writeWorkspaceFiles(dir, {
      'config/attachments.ts': config
        .replace("import { attachments } from '../db/schema'", "import { pgTable, text } from '@guren/orm/drizzle/pg'\n\nconst legacyAttachments = pgTable('legacy_attachments', { id: text('id').primaryKey() })")
        .replace('table: attachments,', 'table: legacyAttachments,'),
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['attachments-config:config/attachments.ts']).toMatchObject({ status: 'warn', advisory: true, evidence: 'manifest' })
    expect(manifest['attachments-config:config/attachments.ts']!.message).toContain("'legacy_attachments'")
    expect(source['attachments-config:config/attachments.ts']).toBeUndefined()
  })

  test('reports a session table under the store name when no config the source reads declares the store', async () => {
    const dir = await scaffoldApp('session-store-spread', [], {
      'config/session.ts': `import { type SessionConfig } from '@guren/core'

const stores = { database: { driver: 'database' as const, table: {} as never } }

export const sessionConfig: SessionConfig = { default: 'database', stores: { ...stores } }
`,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP.replace("import registerWebRoutes", "import SessionProvider from '../app/Providers/SessionProvider.js'\nimport registerWebRoutes")
        .replace('providers: []', 'providers: [SessionProvider]'),
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['sessions-config:database']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(manifest['sessions-config:database']!.filePath).toBeUndefined()
  })

  test('reports a non-Drizzle session table against every config declaring the store', async () => {
    const dir = await scaffoldApp('session-two-configs', ['session'])
    const config = await Bun.file(join(dir, 'config/session.ts')).text()
    await writeWorkspaceFiles(dir, {
      'config/session.ts': config.replace("database: { driver: 'database', table: sessions }", "database: { driver: 'database', table: {} as never }"),
      'config/legacy-session.ts': `import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export const legacySessionConfig: SessionConfig = { default: 'database', stores: { database: { driver: 'database', table: sessions } } }
`,
    })
    const { manifest } = await bothWays(dir)

    const tables = Object.values(manifest).filter((result) => result.key.startsWith('sessions-config:'))
    expect(tables.map((result) => [result.filePath, result.status]).sort()).toEqual([
      ['config/legacy-session.ts', 'fail'],
      ['config/session.ts', 'fail'],
    ])
  })

  test('reports an unmounted delivery route under the rule alone when no call the source reads sets delivery', async () => {
    const dir = await scaffoldApp('delivery-unattributed', ['attachments'], {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      // An options object the scan cannot read, so no literal says which call enables delivery.
      'config/attachments.ts': `import { configureAttachments } from '@guren/core'
import { attachments } from '../db/schema'

const options = { table: attachments, storage: () => ({}) as never, disk: 'local', delivery: {} }

export const { Attachment, engine: attachmentEngine } = configureAttachments(options)
`,
      'app/Support/legacy-attachments.ts': `import { configureAttachments } from '@guren/core'
import { attachments } from '../../db/schema.js'

export function configureLegacy(): void {
  configureAttachments({ table: attachments, storage: () => ({}) as never, disk: 'local' })
}
`,
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['attachments-delivery']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(manifest['attachments-delivery']!.filePath).toBeUndefined()
  })

  test('does not introspect a --changed run that changed no source, and says why', async () => {
    const dir = await scaffoldApp('changed-docs-only', ['session'], {
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })
    const checks = wiring((await runCheck({ cwd: dir, introspect: true, changedFiles: new Set(['docs/notes.md']) })).checks)

    expect(checks['introspection-unavailable']).toBeUndefined()
    expect(checks['sessions-binding-unverified']).toMatchObject({ evidence: 'none', advisory: true })
    expect(checks['sessions-binding-unverified']!.message).toContain('this run changed no source')
    expect(checks['sessions-config:config/session.ts:sessions']!.message).toContain('this run changed no source')
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
      expect({ ...manifest[key], key }).toMatchObject({ key, status: 'fail', evidence: 'manifest' })
      const unverified = key.replace(':', '-unverified:')
      expect({ ...source[unverified], key: unverified }).toMatchObject({ key: unverified, status: 'warn', evidence: 'none', advisory: true })
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
    expect(source['attachments-delivery-unverified:config/attachments.ts']).toMatchObject({ status: 'warn', evidence: 'none' })
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

  test('judges the tables from source after a provider threw, and cannot vouch for the binding or the mount', async () => {
    const dir = await scaffoldApp('threw', ['session', 'attachments'], { 'app/Providers/BindingProvider.ts': THROWING_PROVIDER })
    const app = await Bun.file(join(dir, 'src/app.ts')).text()
    await writeWorkspaceFiles(dir, {
      'src/app.ts': `import BindingProvider from '../app/Providers/BindingProvider.js'\n${app.replace('providers: [', 'providers: [BindingProvider, ')}`,
    })
    const { manifest, source } = await bothWays(dir)

    expect(manifest['introspection-unavailable']).toBeUndefined()
    for (const key of ['sessions-config:config/session.ts:sessions', 'attachments-config:config/attachments.ts']) {
      expect({ ...manifest[key], key }).toMatchObject({ key, status: source[key]!.status, evidence: 'static' })
      expect(manifest[key]!.message).toContain('Judged from source: BindingProvider threw in register()')
    }
    for (const key of ['sessions-binding-unverified', 'attachments-delivery-unverified:config/attachments.ts']) {
      expect({ ...manifest[key], key }).toMatchObject({ key, status: 'warn', evidence: 'none', advisory: true })
      expect(manifest[key]!.message).toContain('BindingProvider threw in register()')
    }
  })

  test('introspects an app with no deploy target once it has a session config, and falls back when that fails', async () => {
    const dir = await scaffoldApp('broken-entry', ['session'], {
      'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n",
    })
    const { manifest } = await bothWays(dir)

    expect(manifest['introspection-unavailable']).toMatchObject({ status: 'warn', advisory: true })
    expect(manifest['introspection-unavailable']!.message).toContain('(import)')
    expect(manifest['sessions-binding-unverified']).toMatchObject({ status: 'warn', evidence: 'none', advisory: true })
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
