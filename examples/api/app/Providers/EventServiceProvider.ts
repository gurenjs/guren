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
import { LogUserRegistration } from '../Listeners/LogUserRegistration.js'
import { NotifyTaskCompleted } from '../Listeners/NotifyTaskCompleted.js'
import { UserRegistered } from '../Events/UserRegistered.js'
import { TaskCompleted } from '../Events/TaskCompleted.js'
import { SendRegistrationEmailJob } from '../Jobs/SendRegistrationEmailJob.js'

let eventManager: EventManager | null = null
let mailManager: MailManager | null = null
let queueManager: QueueManager | null = null
let containerRef: { make<T>(key: string): T } | null = null
let initialized = false

export function initializeEventSystem(): EventManager {
  if (eventManager && initialized) {
    return eventManager
  }

  eventManager = eventManager ?? createEventManager()

  mailManager = mailManager ?? createMailManager({
    default: 'memory',
    from: { email: 'noreply@api.example.com', name: 'Guren API' },
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

  registerJob(SendRegistrationEmailJob)
  registerListeners(eventManager)

  initialized = true
  return eventManager
}

function registerListeners(events: EventManager): void {
  const logUserRegistration = new LogUserRegistration()
  events.on(UserRegistered, (event) => logUserRegistration.handle(event), {
    priority: LogUserRegistration.priority,
  })

  if (!containerRef) {
    throw new Error('EventServiceProvider container has not been registered.')
  }
  const notifications = containerRef.make<NotificationManager>('notifications')
  const broadcast = containerRef.make<BroadcastManager>('broadcast')
  const storage = containerRef.make<StorageManager>('storage')
  const notifyTaskCompleted = new NotifyTaskCompleted(notifications, broadcast, storage)
  events.on(
    TaskCompleted,
    async (event) => {
      if (notifyTaskCompleted.shouldHandle?.(event) !== false) {
        await notifyTaskCompleted.handle(event)
      }
    },
    { priority: NotifyTaskCompleted.priority }
  )

  console.log('[Events] Registered listeners: LogUserRegistration, NotifyTaskCompleted')
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
