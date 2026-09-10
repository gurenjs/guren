import { ServiceProvider } from '../container/ServiceProvider'
import { createEventManager, createQueueEventDispatcher } from '../events'

/** Binds the EventManager as a singleton in the container. */
export class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('events', () => createEventManager())
  }

  /**
   * In boot() rather than register(): the `queue` binding may come from a
   * provider registered after this one. Without it, a `queue:` listener makes
   * emit() throw rather than run inline.
   */
  boot(): void {
    if (this.container.makeOptional('queue')) {
      this.container.make('events').setQueueDispatcher(createQueueEventDispatcher())
    }
  }
}
