import { ServiceProvider } from '../container/ServiceProvider'
import { createNotificationManager, type NotificationManager } from '../notifications'

/** Binds the NotificationManager as a singleton in the container. */
export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('notifications', () => createNotificationManager())
  }

  boot(): void {
    // Register the queued-notification job in every booted process, including
    // a worker that never sends a notification itself.
    this.container
      .make<NotificationManager>('notifications')
      .registerQueueJob()
  }
}
