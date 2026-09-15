import { defineConfig, type AppEnv, type ConfigDefinition, type SessionConfig } from '@guren/server'
import type { ConnectionContext } from '@guren/orm'
import { createSessionManager } from './session-manager.js'

/** What `defineDatabaseConfig()` needs from a dialect factory's result. */
export interface ConfigurableDatabase {
  configureOrm(context?: ConnectionContext): Promise<void>
  seedDatabase(): Promise<unknown>
  hasMigrations(): boolean
}

export interface DatabaseConfig {
  readonly database: ConfigurableDatabase
  /** Run the seeders at boot when the migrations folder holds migrations. */
  readonly seedOnBoot: boolean
}

declare module '@guren/server' {
  interface ConfigDefinitions {
    session: SessionConfig
    database: DatabaseConfig
  }

  interface ServiceBindings {
    /** Bound by `defineDatabaseConfig()` (RFC 0027 §2). */
    database: ConfigurableDatabase
  }
}

declare module '@guren/orm' {
  // oxlint-disable-next-line typescript/no-empty-object-type -- merges AppEnv into the ORM's augmentation target
  interface OrmConnectionEnv extends AppEnv {}
}

/**
 * `config/session.ts` (RFC 0027 §2). Written in core because the manager it
 * binds knows the `database` driver, which `@guren/server` cannot resolve, and
 * it binds the same `session` key an app's SessionProvider does (RFC 0020 §2).
 */
export function defineSessionConfig(resolve: (env: AppEnv) => SessionConfig): ConfigDefinition<'session'> {
  return defineConfig({
    key: 'session',
    resolve,
    bind: (container, config) => {
      container.singleton('session', () => createSessionManager(config))
    },
  })
}

/**
 * `config/database.ts` (RFC 0027 §2). Binds `database`, and at boot connects
 * through `configureOrm({ env })`, so a connection resolver reads the validated
 * env (a test's `envSource` included) rather than `process.env`. Without an env
 * schema the context is omitted, so a resolver's own fallback runs.
 */
export function defineDatabaseConfig(
  database: ConfigurableDatabase,
  options: { readonly seedOnBoot?: boolean } = {},
): ConfigDefinition<'database'> {
  return defineConfig({
    key: 'database',
    resolve: () => ({ database, seedOnBoot: options.seedOnBoot ?? false }),
    bind: (container, config) => {
      container.instance('database', config.database)
    },
    boot: async (container, config, env) => {
      await config.database.configureOrm(container.has('env') ? { env } : undefined)
      if (config.seedOnBoot && config.database.hasMigrations()) {
        await config.database.seedDatabase()
      }
    },
  })
}
