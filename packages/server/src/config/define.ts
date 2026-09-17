/**
 * Configuration as data (RFC 0027 §2). A definition resolves its config from the
 * validated env and binds the manager that config builds; ConfigServiceProvider
 * runs `bind` in its register() and `boot` in its boot(), ahead of every other
 * provider. Importing a definition has no side effect.
 */
import type { Container } from '../container/Container'
import { createCacheManager } from '../cache/CacheManager'
import type { CacheConfig } from '../cache/types'
import { createMailManager } from '../mail/MailManager'
import type { MailConfig } from '../mail/types'
import { createQueueManager, type QueueConfig } from '../queue/QueueManager'
import { createStorageManager } from '../storage/StorageManager'
import type { StorageConfig } from '../storage/types'
import { createOAuthManager, type OAuthProviderConfig, type OAuthStateStore } from '../auth/oauth'
import type { HostAuthorizationOptions } from '../http/middleware/host-authorization'
import type { AppEnv } from './env'

export interface HttpConfig {
  /** DNS rebinding protection, mounted ahead of every app middleware. Absent or `false` disables it. */
  readonly hostAuthorization?: HostAuthorizationOptions | false
}

export interface OAuthConfig {
  /** Each entry is registered with `OAuthManager.registerProvider(name, config)`. */
  readonly providers?: Readonly<Record<string, OAuthProviderConfig>>
  /** Where authorize states wait for their callback; process memory when absent. */
  readonly stateStore?: OAuthStateStore
}

/** What each key configures. Augmentable, like `SessionDrivers`: `@guren/core` adds `session` and `database`. */
export interface ConfigDefinitions {
  cache: CacheConfig
  http: HttpConfig
  mail: MailConfig
  oauth: OAuthConfig
  queue: QueueConfig
  storage: StorageConfig
}

export interface ConfigDefinition<K extends keyof ConfigDefinitions = keyof ConfigDefinitions> {
  readonly key: K
  resolve(env: AppEnv): ConfigDefinitions[K]
  /** Runs in ConfigServiceProvider.register(). Binds; never connects. */
  bind(container: Container, config: ConfigDefinitions[K]): void
  /** Runs in ConfigServiceProvider.boot(), before every other provider's boot. */
  boot?(container: Container, config: ConfigDefinitions[K], env: AppEnv): Promise<void> | void
}

export function defineConfig<K extends keyof ConfigDefinitions>(definition: ConfigDefinition<K>): ConfigDefinition<K> {
  return definition
}

type Resolve<K extends keyof ConfigDefinitions> = (env: AppEnv) => ConfigDefinitions[K]

export function defineCacheConfig(resolve: Resolve<'cache'>): ConfigDefinition<'cache'> {
  return defineConfig({
    key: 'cache',
    resolve,
    bind: (container, config) => {
      container.singleton('cache', () => createCacheManager(config))
    },
  })
}

export function defineHttpConfig(resolve: Resolve<'http'>): ConfigDefinition<'http'> {
  return defineConfig({
    key: 'http',
    resolve,
    bind: (container, config) => {
      container.instance('http.hostAuthorization', config.hostAuthorization ?? false)
    },
  })
}

export function defineMailConfig(resolve: Resolve<'mail'>): ConfigDefinition<'mail'> {
  return defineConfig({
    key: 'mail',
    resolve,
    bind: (container, config) => {
      container.singleton('mail', (resolving) => createMailManager(config, resolving))
    },
  })
}

export function defineOAuthConfig(resolve: Resolve<'oauth'>): ConfigDefinition<'oauth'> {
  return defineConfig({
    key: 'oauth',
    resolve,
    bind: (container, config) => {
      container.singleton('oauth', () => {
        const manager = createOAuthManager({ stateStore: config.stateStore })
        for (const [name, provider] of Object.entries(config.providers ?? {})) {
          manager.registerProvider(name, provider)
        }
        return manager
      })
    },
  })
}

export function defineQueueConfig(resolve: Resolve<'queue'>): ConfigDefinition<'queue'> {
  return defineConfig({
    key: 'queue',
    resolve,
    bind: (container, config) => {
      container.singleton('queue', () => createQueueManager(config))
    },
  })
}

export function defineStorageConfig(resolve: Resolve<'storage'>): ConfigDefinition<'storage'> {
  return defineConfig({
    key: 'storage',
    resolve,
    bind: (container, config) => {
      container.singleton('storage', () => createStorageManager(config))
    },
  })
}
