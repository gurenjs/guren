import { SessionManager, type SessionConfig } from '@guren/server'
import { DatabaseSessionStore, type DatabaseSessionStoreOptions } from './session-store.js'

/**
 * The `database` driver's config. `table` is the app's own drizzle `sessions`
 * table: core cannot name one for it, since a table drizzle-kit does not see
 * in `db/schema.ts` gets no migration (RFC 0020 §1).
 */
export interface DatabaseSessionDriverOptions extends DatabaseSessionStoreOptions {
  /** The `sessions` table, with `id`, `data` and `expiresAt` columns. */
  table: unknown
}

declare module '@guren/server' {
  interface SessionDrivers {
    database: DatabaseSessionDriverOptions
  }
}

/**
 * A `SessionManager` that knows the `database` driver, which `@guren/server`
 * cannot register itself: the store wraps the table in an ORM model, and
 * server must not depend on `@guren/orm` (RFC 0003, Alternatives). Registered
 * here rather than by importing this module for its side effect, so a bundler
 * that drops an unused import cannot drop the driver with it.
 */
export function createSessionManager(config: SessionConfig = {}): SessionManager {
  const manager = new SessionManager(config)
  registerDatabaseSessionDriver(manager)
  return manager
}

/** Adds the `database` driver to a manager built elsewhere (a plugin's, or a subclass). */
export function registerDatabaseSessionDriver(manager: SessionManager): void {
  manager.registerDriver('database', ({ table, ...options }) => new DatabaseSessionStore(table, options))
}
