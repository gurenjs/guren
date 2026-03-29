import { ServiceProvider } from '../container/ServiceProvider'
import { createBroadcastManager } from '../broadcasting'

/**
 * Binds the BroadcastManager as a singleton in the container.
 */
export class BroadcastServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('broadcast', () => createBroadcastManager())
  }
}
