import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import type { CheckResult } from '../src/check-result'
import type { IntrospectOption } from '../src/introspect'
import {
  createTempWorkspace,
  introspected,
  manifestFixture,
  PG_SCHEMA_FIXTURE,
  SESSION_PROVIDER,
  sessionConfigSource,
  writeWorkspaceFiles,
} from './helpers'

const SESSIONS_TABLE = `
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
`

const SCHEMA_WITH_SESSIONS = `${PG_SCHEMA_FIXTURE}${SESSIONS_TABLE}`
const CONFIG = sessionConfigSource("database: { driver: 'database', table: sessions }")

const APP_WITH_PROVIDER = `import { createApp } from '@guren/core'
import SessionProvider from '../app/Providers/SessionProvider.js'

export default createApp({ auth: {}, providers: [SessionProvider] })
`

const APP_WITHOUT_PROVIDER = `import { createApp } from '@guren/core'

export default createApp({ auth: {}, providers: [] })
`

/** The introspected app with the session manager `guren add session` binds. */
const BOUND = manifestFixture({
  session: { source: 'manager', default: 'database', stores: { database: { driver: 'database', table: 'sessions', perProcess: false } } },
})

/** An app whose `createApp({ auth })` attaches the session middleware and nothing binds `session`. */
const UNBOUND = manifestFixture({
  session: { source: 'none', default: 'memory', stores: { memory: { driver: 'memory', perProcess: true } } },
})

/** The session rules' results from a full check run over a throwaway app. */
async function sessionResults(files: Record<string, string>, introspect: IntrospectOption = false): Promise<CheckResult[]> {
  const workspace = await createTempWorkspace('guren-sessions-check-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    const report = await runCheck({ cwd: workspace.dir, introspect })
    return report.checks.filter((result) => result.key.startsWith('sessions-'))
  } finally {
    await workspace.cleanup()
  }
}

const WIRED = {
  'db/schema.ts': SCHEMA_WITH_SESSIONS,
  'config/session.ts': CONFIG,
  'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
  'src/app.ts': APP_WITH_PROVIDER,
}

describe('guren check sessions wiring (RFC 0020)', () => {
  it('passes a config whose table the schema exports and which the introspected app binds', async () => {
    const results = await sessionResults(WIRED, introspected(BOUND))

    expect(results.map((result) => [result.key, result.status, result.evidence])).toEqual([
      ['sessions-config:config/session.ts:sessions', 'pass', 'manifest'],
      ['sessions-binding', 'pass', 'manifest'],
    ])
  })

  it('warns when the introspected app binds no session manager, so the config is never read', async () => {
    const results = await sessionResults({ ...WIRED, 'src/app.ts': APP_WITHOUT_PROVIDER }, introspected(UNBOUND))
    const binding = results.find((result) => result.key === 'sessions-binding')

    expect(binding?.status).toBe('warn')
    expect(binding?.message).toContain("binds no 'session' in register()")
    expect(binding?.suggestion).toContain('guren add session')
    // A config the app does not read keeps its table verdict, from source.
    expect(results.find((result) => result.key.startsWith('sessions-config:'))).toMatchObject({ status: 'pass', evidence: 'static' })
  })

  it('reports the binding unverified without the introspected app, and keeps it out of the gate', async () => {
    const results = await sessionResults(WIRED)
    const binding = results.find((result) => result.key === 'sessions-binding-unverified')

    expect(results.some((result) => result.key === 'sessions-binding')).toBe(false)
    expect(binding).toMatchObject({ status: 'warn', advisory: true, evidence: 'none' })
    expect(binding?.message).toContain('no introspected app was available')
    expect(binding?.suggestion).toContain('guren introspect')
  })

  it('names why the binding is unverified when a provider threw', async () => {
    const threw = manifestFixture({
      providers: [{ name: 'SessionProvider', source: 'options.providers', deferred: false, provides: [], register: 'threw', error: 'no binding' }],
    })
    const binding = (await sessionResults(WIRED, introspected(threw))).find((result) => result.key === 'sessions-binding-unverified')

    expect(binding?.message).toContain('SessionProvider threw in register()')
  })

  // A missing named export is a link error that fails the introspection, so the source is all there is.
  it('fails when the database store binds a table no schema exports', async () => {
    const results = await sessionResults({ ...WIRED, 'db/schema.ts': PG_SCHEMA_FIXTURE })
    const table = results.find((result) => result.key.startsWith('sessions-config:'))

    expect(table).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(table?.message).toContain("binds the database session store to 'sessions'")
    expect(table?.message).toContain('only fails at runtime')
  })

  // RFC 0027 §2: the table rule reads the resolver's object; `config-unwired`, not the
  // provider rule, judges whether a definition is bound.
  it('judges the table of a defineSessionConfig() definition, with no provider to find', async () => {
    const definition = `import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export default defineSessionConfig((env) => {
  return { default: env.SESSION_DRIVER, stores: { database: { driver: 'database', table: sessions } } }
})
`
    const results = await sessionResults({
      'db/schema.ts': PG_SCHEMA_FIXTURE,
      'config/session.ts': definition,
      'src/app.ts': `import { createApp } from '@guren/core'
import session from '../config/session.js'

export default createApp({ auth: {}, config: [session] })
`,
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['sessions-config:config/session.ts:sessions', 'fail']])
  })

  it('reads a config declared with `satisfies`, not only with an annotation', async () => {
    const results = await sessionResults({
      ...WIRED,
      'config/session.ts': `import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export const sessionConfig = {
  default: 'database',
  stores: { database: { driver: 'database', table: sessions } },
} satisfies SessionConfig
`,
    }, introspected(BOUND))

    expect(results.map((result) => result.status)).toEqual(['pass', 'pass'])
  })

  it('contributes nothing to an app with no session config', async () => {
    expect(await sessionResults({ 'db/schema.ts': PG_SCHEMA_FIXTURE }, introspected(BOUND))).toEqual([])
  })
})
