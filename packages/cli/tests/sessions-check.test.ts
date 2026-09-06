import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { runCheck } from '../src/check'
import type { CheckResult } from '../src/check-result'
import { createTempWorkspace, PG_SCHEMA_FIXTURE } from './helpers'

const SESSIONS_TABLE = `
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
`

const CONFIG = `import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export const sessionConfig: SessionConfig = {
  default: process.env.SESSION_DRIVER ?? 'database',
  stores: { database: { driver: 'database', table: sessions } },
}
`

const PROVIDER = `import { createSessionManager, ServiceProvider } from '@guren/core'
import { sessionConfig } from '../../config/session'

export default class SessionProvider extends ServiceProvider {
  register(): void {
    this.container.instance('session', createSessionManager(sessionConfig))
  }
}
`

async function seed(files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await mkdir(dir, { recursive: true })
    await writeFile(path, contents)
  }
}

/** Just the session rules' results from a full check run. */
async function sessionResults(cwd: string): Promise<CheckResult[]> {
  const report = await runCheck({ cwd })
  return report.checks.filter((result) => result.key.startsWith('sessions-'))
}

describe('guren check sessions wiring (RFC 0020)', () => {
  it('passes a config whose table the schema exports and whose manager is bound', async () => {
    const workspace = await createTempWorkspace('guren-sessions-check-ok-')
    try {
      await seed({
        'db/schema.ts': `${PG_SCHEMA_FIXTURE}${SESSIONS_TABLE}`,
        'config/session.ts': CONFIG,
        'app/Providers/SessionProvider.ts': PROVIDER,
      })

      const results = await sessionResults(workspace.dir)

      expect(results.map((result) => result.status)).toEqual(['pass', 'pass'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when nothing binds the session manager, so the config is never read', async () => {
    const workspace = await createTempWorkspace('guren-sessions-check-unbound-')
    try {
      await seed({
        'db/schema.ts': `${PG_SCHEMA_FIXTURE}${SESSIONS_TABLE}`,
        'config/session.ts': CONFIG,
      })

      const results = await sessionResults(workspace.dir)
      const binding = results.find((result) => result.key === 'sessions-binding')

      expect(binding?.status).toBe('warn')
      expect(binding?.message).toContain('in-memory default')
      expect(binding?.suggestion).toContain('guren add session')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when the database store binds a table no schema exports', async () => {
    const workspace = await createTempWorkspace('guren-sessions-check-table-')
    try {
      await seed({
        'db/schema.ts': PG_SCHEMA_FIXTURE,
        'config/session.ts': CONFIG,
        'app/Providers/SessionProvider.ts': PROVIDER,
      })

      const results = await sessionResults(workspace.dir)
      const table = results.find((result) => result.key.includes('sessions'))

      expect(table?.status).toBe('fail')
      expect(table?.message).toContain("binds the database session store to 'sessions'")
      expect(table?.message).toContain('only fails at runtime')
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds the binding through the passed app root, not the process cwd', async () => {
    const workspace = await createTempWorkspace('guren-sessions-check-cwd-')
    await seed({
      'db/schema.ts': `${PG_SCHEMA_FIXTURE}${SESSIONS_TABLE}`,
      'config/session.ts': CONFIG,
      'app/Providers/SessionProvider.ts': PROVIDER,
    })
    // createTempWorkspace() chdirs into what it makes, which is what moves the
    // process cwd away from the app under check. runCheck({ cwd }) is a
    // supported entry point (the MCP server uses it), so the scan must read
    // the root it was given rather than wherever the process happens to be.
    const outside = await createTempWorkspace('guren-sessions-check-elsewhere-')
    try {

      const binding = (await sessionResults(workspace.dir)).find((result) => result.key === 'sessions-binding')

      expect(binding?.status).toBe('pass')
    } finally {
      process.chdir(workspace.dir)
      await outside.cleanup()
      await workspace.cleanup()
    }
  })

  it('contributes nothing to an app with no session config', async () => {
    const workspace = await createTempWorkspace('guren-sessions-check-absent-')
    try {
      await seed({ 'db/schema.ts': PG_SCHEMA_FIXTURE })

      expect(await sessionResults(workspace.dir)).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })
})
