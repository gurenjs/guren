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
import type { SessionManager } from '../http/middleware/session-manager'

/** Maps service keys to their concrete types, for `container.make('key')`. */
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
  /** Bound by an app's SessionProvider; AuthServiceProvider resolves the store through it (RFC 0020). */
  session: SessionManager
  oauth: OAuthManager
  storage: StorageManager
  health: HealthManager
  scheduler: Scheduler
  gate: Gate
  /** Bound lazily on the first `shareInertiaProps(fn, container)` call. */
  'inertia.sharedProps': SharedInertiaPropsRegistry
  /**
   * How an agent surface records what it did (RFC 0016 §5.2). Bound by
   * `@guren/plugin-mcp` at boot, absent when no MCP plugin is registered. The
   * binding is the *emitter*, not the sink, so every surface's records reach
   * the same place the same way. The runtime spelling of this name lives in
   * `AGENT_AUDIT_BINDING` — rename here and there together.
   */
  'agent.audit': AgentAuditEmitter
  'exception.handler': ExceptionHandler
}
