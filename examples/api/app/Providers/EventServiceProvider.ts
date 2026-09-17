import {
  ServiceProvider,
  createEventManager,
  registerJob,
  type EventManager,
  type NotificationManager,
  type BroadcastManager,
  type StorageManager,
} from '@guren/core'
import { LogUserRegistration } from '../Listeners/LogUserRegistration.js'
import { NotifyTaskCompleted } from '../Listeners/NotifyTaskCompleted.js'
import { TaskCompleted } from '../Events/TaskCompleted.js'
import { SendRegistrationEmailJob } from '../Jobs/SendRegistrationEmailJob.js'

/**
 * Events and their listeners. Mail, queue, cache and storage are config
 * definitions (config/*.ts); job registration and listener wiring are
 * imperative, so they stay here.
 */
export default class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('events', () => createEventManager())
  }

  boot(): void {
    registerJob(SendRegistrationEmailJob)

    const events = this.container.make<EventManager>('events')
    events.listen(LogUserRegistration)

    const notifyTaskCompleted = new NotifyTaskCompleted(
      this.container.make<NotificationManager>('notifications'),
      this.container.make<BroadcastManager>('broadcast'),
      this.container.make<StorageManager>('storage'),
    )
    events.on(
      TaskCompleted,
      async (event) => {
        if (notifyTaskCompleted.shouldHandle?.(event) !== false) {
          await notifyTaskCompleted.handle(event)
        }
      },
      { priority: NotifyTaskCompleted.priority },
    )

    console.log('[Events] Registered listeners: LogUserRegistration, NotifyTaskCompleted')
  }
}
