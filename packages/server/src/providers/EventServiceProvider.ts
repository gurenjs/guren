import { ServiceProvider } from '../container/ServiceProvider'
import { createEventManager } from '../events'

/** Binds the EventManager as a singleton in the container. */
export class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('events', () => createEventManager())
  }
}
