import { ServiceProvider } from '../container/ServiceProvider'
import {
  createNotificationManager,
  setNotificationManager,
  type NotificationManager,
} from '../notifications'

/** Binds the NotificationManager as a singleton in the container. */
export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('notifications', () => createNotificationManager())
  }

  boot(): void {
    const manager = this.container.make<NotificationManager>('notifications')
    setNotificationManager(manager)
    // Registered in every booted process, including a worker that never sends
    // a notification itself.
    manager.registerQueueJob()
  }
}
