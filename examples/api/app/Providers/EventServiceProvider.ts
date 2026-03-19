import {
  createEventManager,
  createMailManager,
  setMailManager,
  setQueueDriver,
  MemoryDriver,
  registerJob,
  type EventManager,
} from '@guren/server'
import { LogUserRegistration } from '../Listeners/LogUserRegistration.js'
import { NotifyTaskCompleted } from '../Listeners/NotifyTaskCompleted.js'
import { UserRegistered } from '../Events/UserRegistered.js'
import { TaskCompleted } from '../Events/TaskCompleted.js'
import { SendRegistrationEmailJob } from '../Jobs/SendRegistrationEmailJob.js'

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
    from: { email: 'noreply@api.example.com', name: 'Guren API' },
    transports: {
      memory: { driver: 'memory' },
    },
  })
  setMailManager(mailManager)

  // Configure queue (using memory driver for development)
  const queueDriver = new MemoryDriver()
  setQueueDriver(queueDriver)

  // Register jobs
  registerJob(SendRegistrationEmailJob)

  console.log('[Events] Event system initialized')
  return eventManager
}

/**
 * Register all event listeners.
 */
function registerListeners(events: EventManager): void {
  // UserRegistered listeners
  const logUserRegistration = new LogUserRegistration()
  events.on(UserRegistered, (event) => logUserRegistration.handle(event), {
    priority: LogUserRegistration.priority,
  })

  // TaskCompleted listeners
  const notifyTaskCompleted = new NotifyTaskCompleted()
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
