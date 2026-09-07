import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import type { CheckResult } from '../src/check-result'
import {
  createTempWorkspace,
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

/** The session rules' results from a full check run over a throwaway app. */
async function sessionResults(files: Record<string, string>, run?: (dir: string) => Promise<void>): Promise<CheckResult[]> {
  const workspace = await createTempWorkspace('guren-sessions-check-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    await run?.(workspace.dir)
    const report = await runCheck({ cwd: workspace.dir })
    return report.checks.filter((result) => result.key.startsWith('sessions-'))
  } finally {
    await workspace.cleanup()
  }
}

describe('guren check sessions wiring (RFC 0020)', () => {
  it('passes a config whose table the schema exports and whose provider is registered', async () => {
    const results = await sessionResults({
      'db/schema.ts': SCHEMA_WITH_SESSIONS,
      'config/session.ts': CONFIG,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP_WITH_PROVIDER,
    })

    expect(results.map((result) => result.status)).toEqual(['pass', 'pass'])
  })

  it('warns when nothing binds the session manager, so the config is never read', async () => {
    const results = await sessionResults({
      'db/schema.ts': SCHEMA_WITH_SESSIONS,
      'config/session.ts': CONFIG,
      'src/app.ts': APP_WITHOUT_PROVIDER,
    })
    const binding = results.find((result) => result.key === 'sessions-binding')

    expect(binding?.status).toBe('warn')
    expect(binding?.message).toContain("no provider binds 'session'")
    expect(binding?.suggestion).toContain('guren add session')
  })

  it('warns when the binding provider exists but createApp never registers it', async () => {
    const results = await sessionResults({
      'db/schema.ts': SCHEMA_WITH_SESSIONS,
      'config/session.ts': CONFIG,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP_WITHOUT_PROVIDER,
    })
    const binding = results.find((result) => result.key === 'sessions-binding')

    // The file being there is not the question: an unregistered provider never
    // runs, which is the inert-config case this rule exists for.
    expect(binding?.status).toBe('warn')
    expect(binding?.message).toContain('does not register it')
    expect(binding?.message).toContain('app/Providers/SessionProvider.ts')
  })

  it('fails when the database store binds a table no schema exports', async () => {
    const results = await sessionResults({
      'db/schema.ts': PG_SCHEMA_FIXTURE,
      'config/session.ts': CONFIG,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP_WITH_PROVIDER,
    })
    const table = results.find((result) => result.key.startsWith('sessions-config:'))

    expect(table?.status).toBe('fail')
    expect(table?.message).toContain("binds the database session store to 'sessions'")
    expect(table?.message).toContain('only fails at runtime')
  })

  it('reads a config declared with `satisfies`, not only with an annotation', async () => {
    const results = await sessionResults({
      'db/schema.ts': SCHEMA_WITH_SESSIONS,
      'config/session.ts': `import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export const sessionConfig = {
  default: 'database',
  stores: { database: { driver: 'database', table: sessions } },
} satisfies SessionConfig
`,
      'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
      'src/app.ts': APP_WITH_PROVIDER,
    })

    expect(results.map((result) => result.status)).toEqual(['pass', 'pass'])
  })

  it('finds the binding through the passed app root, not the process cwd', async () => {
    // createTempWorkspace() chdirs into what it makes, so creating a second one
    // moves the process cwd away from the app under check. runCheck({ cwd }) is
    // a supported entry point (the MCP server uses it), so the scan must read
    // the root it was given.
    const results = await sessionResults(
      {
        'db/schema.ts': SCHEMA_WITH_SESSIONS,
        'config/session.ts': CONFIG,
        'app/Providers/SessionProvider.ts': SESSION_PROVIDER,
        'src/app.ts': APP_WITH_PROVIDER,
      },
      async () => {
        await createTempWorkspace('guren-sessions-check-elsewhere-')
      },
    )

    expect(results.find((result) => result.key === 'sessions-binding')?.status).toBe('pass')
  })

  it('contributes nothing to an app with no session config', async () => {
    expect(await sessionResults({ 'db/schema.ts': PG_SCHEMA_FIXTURE })).toEqual([])
  })
})
