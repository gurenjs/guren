import type { Hono } from 'hono'
import type { Application } from '../http/Application'
import type { EventManager } from '../events'
import type { CacheManager } from '../cache'
import type { QueueManager } from '../queue'
import type { MailManager } from '../mail'
import type { LogManager } from '../logging'
import type { I18nManager } from '../i18n'
import type { NotificationManager } from '../notifications'
import type { BroadcastManager } from '../broadcasting'
import type { Encrypter } from '../encryption'
import type { AppKeyring } from '../encryption/app-key'
import type { AuthManager } from '../auth/AuthManager'
import type { OAuthManager } from '../auth/oauth'
import type { StorageManager } from '../storage'
import type { HealthManager } from '../health'
import type { Scheduler } from '../scheduling'
import type { Gate } from '../authorization/Gate'
import type { ExceptionHandler } from '../errors'
import type { SharedInertiaPropsRegistry } from '../mvc/inertia/shared'
import type { AgentAuditEmitter } from '../agent/audit-emitter'

/**
 * Type-safe service binding map.
 *
 * Maps service keys to their concrete types for type-safe resolution
 * via `container.make('key')`.
 *
 * @example
 * ```typescript
 * const events = container.make('events') // EventManager
 * const cache = container.make('cache')   // CacheManager
 * ```
 */
export interface ServiceBindings {
  app: Application
  hono: Hono
  events: EventManager
  cache: CacheManager
  queue: QueueManager
  mail: MailManager
  log: LogManager
  i18n: I18nManager
  notifications: NotificationManager
  broadcast: BroadcastManager
  encrypter: Encrypter
  'app.keyring': AppKeyring
  auth: AuthManager
  oauth: OAuthManager
  storage: StorageManager
  health: HealthManager
  scheduler: Scheduler
  gate: Gate
  /** Bound lazily on the first `shareInertiaProps(fn, container)` call. */
  'inertia.sharedProps': SharedInertiaPropsRegistry
  /**
   * How an agent surface records what it did (RFC 0016 §5.2). Bound by
   * `@guren/plugin-mcp` at boot, and absent when no MCP plugin is registered
   * — the key is declared here, where every other service name is, so that a
   * surface resolving it and the plugin binding it spell one string.
   *
   * The binding is the *emitter*, not the sink: a second caller that resolved
   * a sink would have to build its own emitter around it, and the two would
   * then differ on the questions the emitter answers — whether a sink failure
   * warns, whether the events are emitted beside it. One emitter per
   * application means every surface's records reach the same place the same
   * way.
   *
   * An interface key cannot be a constant, so the *runtime* spelling of this
   * name lives once in `AGENT_AUDIT_BINDING`, which both the writing and the
   * reading package import. Rename here and there together.
   */
  'agent.audit': AgentAuditEmitter
  'exception.handler': ExceptionHandler
}
