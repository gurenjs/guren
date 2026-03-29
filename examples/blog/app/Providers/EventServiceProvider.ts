import {
  ServiceProvider,
  createEventManager,
  createMailManager,
  createQueueManager,
  setMailManager,
  MemoryDriver,
  registerJob,
  type EventManager,
  type MailManager,
  type QueueManager,
  type NotificationManager,
  type BroadcastManager,
  type StorageManager,
} from '@guren/core'
import { LogUserLogin } from '../Listeners/LogUserLogin.js'
import { SendNewPostNotification } from '../Listeners/SendNewPostNotification.js'
import { UserLoggedIn } from '../Events/UserLoggedIn.js'
import { PostCreated } from '../Events/PostCreated.js'
import { SendWelcomeEmailJob } from '../Jobs/SendWelcomeEmailJob.js'
import { ProcessNewPostJob } from '../Jobs/ProcessNewPostJob.js'

let eventManager: EventManager | null = null
let mailManager: MailManager | null = null
let queueManager: QueueManager | null = null
let containerRef: { make<T>(key: string): T } | null = null
let initialized = false

/**
 * Initialize events, mail, and queue systems.
 */
export function initializeEventSystem(): EventManager {
  if (eventManager && initialized) {
    return eventManager
  }

  eventManager = eventManager ?? createEventManager()

  mailManager = mailManager ?? createMailManager({
    default: 'memory',
    from: { email: 'noreply@blog.example.com', name: 'Guren Blog' },
    transports: {
      memory: { driver: 'memory' },
    },
  })
  setMailManager(mailManager)

  queueManager = queueManager ?? createQueueManager({
    default: 'memory',
    drivers: {
      memory: () => new MemoryDriver(),
    },
  })
  queueManager.driver()

  registerJob(SendWelcomeEmailJob)
  registerJob(ProcessNewPostJob)
  registerListeners(eventManager)

  initialized = true
  return eventManager
}

/**
 * Register all event listeners.
 */
function registerListeners(events: EventManager): void {
  // UserLoggedIn listeners
  const logUserLogin = new LogUserLogin()
  events.on(UserLoggedIn, (event) => logUserLogin.handle(event), {
    priority: LogUserLogin.priority,
  })

  // PostCreated listeners
  if (!containerRef) {
    throw new Error('EventServiceProvider container has not been registered.')
  }
  const notifications = containerRef.make<NotificationManager>('notifications')
  const broadcast = containerRef.make<BroadcastManager>('broadcast')
  const storage = containerRef.make<StorageManager>('storage')
  const sendNewPostNotification = new SendNewPostNotification(notifications, broadcast, storage)
  events.on(
    PostCreated,
    async (event) => {
      if (sendNewPostNotification.shouldHandle?.(event) !== false) {
        await sendNewPostNotification.handle(event)
      }
    },
    { priority: SendNewPostNotification.priority }
  )

  console.log('[Events] Registered listeners: LogUserLogin, SendNewPostNotification')
}

export default class EventServiceProvider extends ServiceProvider {
  register(): void {
    containerRef = this.container
    this.container.singleton('events', () => initializeEventSystem())
    this.container.singleton('mail', () => {
      initializeEventSystem()
      return mailManager as MailManager
    })
    this.container.singleton('queue', () => {
      initializeEventSystem()
      return queueManager as QueueManager
    })
  }

  boot(): void {
    initializeEventSystem()
  }
}
