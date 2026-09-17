import {
  ServiceProvider,
  createEventManager,
  registerJob,
  type EventManager,
  type NotificationManager,
  type BroadcastManager,
  type StorageManager,
} from '@guren/core'
import { LogUserLogin } from '../Listeners/LogUserLogin.js'
import { SendNewPostNotification } from '../Listeners/SendNewPostNotification.js'
import { PostCreated } from '../Events/PostCreated.js'
import { SendWelcomeEmailJob } from '../Jobs/SendWelcomeEmailJob.js'
import { ProcessNewPostJob } from '../Jobs/ProcessNewPostJob.js'
import { SendPasswordResetEmailJob } from '../Jobs/SendPasswordResetEmailJob.js'

export default class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('events', () => createEventManager())
  }

  boot(): void {
    registerJob(SendWelcomeEmailJob)
    registerJob(ProcessNewPostJob)
    registerJob(SendPasswordResetEmailJob)

    const events = this.container.make<EventManager>('events')
    events.listen(LogUserLogin)

    const sendNewPostNotification = new SendNewPostNotification(
      this.container.make<NotificationManager>('notifications'),
      this.container.make<BroadcastManager>('broadcast'),
      this.container.make<StorageManager>('storage'),
    )
    events.on(
      PostCreated,
      async (event) => {
        if (sendNewPostNotification.shouldHandle?.(event) !== false) {
          await sendNewPostNotification.handle(event)
        }
      },
      { priority: SendNewPostNotification.priority },
    )

    console.log('[Events] Registered listeners: LogUserLogin, SendNewPostNotification')
  }
}
