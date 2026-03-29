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
  'exception.handler': ExceptionHandler
}
