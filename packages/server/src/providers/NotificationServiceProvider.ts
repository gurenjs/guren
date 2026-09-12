import { ServiceProvider } from '../container/ServiceProvider'
import { createNotificationManager, type NotificationManager } from '../notifications'

/**
 * Binds the NotificationManager as a singleton in the container;
 * `getNotificationManager()` resolves it from the default application (RFC 0023 §4).
 */
export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('notifications', () => createNotificationManager())
  }

  boot(): void {
    // Registered in every booted process, including a worker that never sends
    // a notification itself.
    this.container.make<NotificationManager>('notifications').registerQueueJob()
  }
}
