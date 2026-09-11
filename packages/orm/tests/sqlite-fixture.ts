import { afterEach, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

/**
 * A fresh in-memory database per test with `ddl` applied, configured as the
 * adapter's. `log`, when given, collects drizzle's rendered SQL and is emptied
 * between tests. `configure()` per test also resets the adapter's module-level
 * transaction queue and dialect memo.
 */
export function useSqlite(ddl: string, options: { log?: string[] } = {}): () => Database {
  let sqlite: Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(ddl)
    const log = options.log
    if (log) log.length = 0
    DrizzleAdapter.configure(drizzle({
      client: sqlite,
      logger: log ? { logQuery: (sql) => void log.push(sql) } : undefined,
    }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  return () => sqlite
}
