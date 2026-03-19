import {
  createEventManager,
  createMailManager,
  setMailManager,
  setQueueDriver,
  MemoryDriver,
  registerJob,
  type EventManager,
} from '@guren/server'
import { LogUserLogin } from '../Listeners/LogUserLogin.js'
import { SendNewPostNotification } from '../Listeners/SendNewPostNotification.js'
import { UserLoggedIn } from '../Events/UserLoggedIn.js'
import { PostCreated } from '../Events/PostCreated.js'
import { SendWelcomeEmailJob } from '../Jobs/SendWelcomeEmailJob.js'
import { ProcessNewPostJob } from '../Jobs/ProcessNewPostJob.js'

let eventManager: EventManager | null = null

/**
 * Initialize events, mail, and queue systems.
 */
export function initializeEventSystem(): EventManager {
  if (eventManager) {
    return eventManager
  }

  // Create and configure event manager
  eventManager = createEventManager()

  // Register event listeners
  registerListeners(eventManager)

  // Configure mail (using memory transport for development)
  const mailManager = createMailManager({
    default: 'memory',
    from: { email: 'noreply@blog.example.com', name: 'Guren Blog' },
    transports: {
      memory: { driver: 'memory' },
    },
  })
  setMailManager(mailManager)

  // Configure queue (using memory driver for development)
  const queueDriver = new MemoryDriver()
  setQueueDriver(queueDriver)

  // Register jobs
  registerJob(SendWelcomeEmailJob)
  registerJob(ProcessNewPostJob)

  console.log('[Events] Event system initialized')
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
  const sendNewPostNotification = new SendNewPostNotification()
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

/**
 * Get the event manager instance.
 */
export function getEventManager(): EventManager {
  if (!eventManager) {
    return initializeEventSystem()
  }
  return eventManager
}

export default {
  boot(): void {
    initializeEventSystem()
  },
}
