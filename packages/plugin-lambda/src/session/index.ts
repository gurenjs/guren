import type { SessionManager } from '@guren/server'
import { DynamoDbSessionStore, type DynamoDbSessionStoreOptions } from './dynamodb-store.js'

/**
 * The `dynamodb` driver's config. `table` defaults to DYNAMODB_SESSIONS_TABLE,
 * which the CDK construct's `sessionsTable` sets on every function.
 */
export interface DynamoDbSessionDriverOptions extends Omit<DynamoDbSessionStoreOptions, 'table'> {
  table?: string
}

declare module '@guren/server' {
  interface SessionDrivers {
    dynamodb: DynamoDbSessionDriverOptions
  }
}

/**
 * Adds the `dynamodb` driver to a manager. A function call, never a module
 * side effect: a bundler that drops an unused import would otherwise drop the
 * driver with it (RFC 0020 §4, same rule as core's `database`).
 *
 * @example registerDynamoDbSessionDriver(createSessionManager(sessionConfig))
 */
export function registerDynamoDbSessionDriver(manager: SessionManager): void {
  manager.registerDriver('dynamodb', ({ table, ...options }) => {
    const name = table ?? process.env.DYNAMODB_SESSIONS_TABLE
    if (!name) {
      throw new Error(
        'The dynamodb session driver needs a table: set DYNAMODB_SESSIONS_TABLE, or pass `table` in config/session.ts.',
      )
    }

    return new DynamoDbSessionStore({ ...options, table: name })
  })
}

export { DynamoDbSessionStore }
export type { DynamoDbSessionStoreOptions }
