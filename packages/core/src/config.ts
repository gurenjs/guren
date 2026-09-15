import { defineConfig, type AppEnv, type ConfigDefinition, type SessionConfig } from '@guren/server'
import { createSessionManager } from './session-manager.js'

declare module '@guren/server' {
  interface ConfigDefinitions {
    session: SessionConfig
  }
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
