import { ServiceProvider } from '../container/ServiceProvider'
import { createQueueManager } from '../queue'

/**
 * Binds the QueueManager as a singleton in the container.
 */
export class QueueServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('queue', () => createQueueManager())
  }
}
