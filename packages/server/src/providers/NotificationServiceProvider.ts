import { ServiceProvider } from '../container/ServiceProvider'
import { createNotificationManager } from '../notifications'

/**
 * Binds the NotificationManager as a singleton in the container.
 */
export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('notifications', () => createNotificationManager())
  }
}
