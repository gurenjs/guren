import { ServiceProvider } from '../container/ServiceProvider'
import { createEventManager, createQueueEventDispatcher } from '../events'
import { getQueueDriver } from '../queue'

/** Binds the EventManager as a singleton in the container. */
export class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('events', () => createEventManager())
  }

  boot(): void {
    // Register the queued-event job in every booted process, including a worker
    // that never emits itself. Installed unconditionally: the dispatcher looks
    // the driver up per emit, so a `queue` bound by a provider registered after
    // this one — or resolved lazily — is still reached.
    this.container
      .make('events')
      .setQueueDispatcher(createQueueEventDispatcher(), () => getQueueDriver() !== null)
  }
}
