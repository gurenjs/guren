import { ServiceProvider } from '../container/ServiceProvider'
import { createBroadcastManager, setBroadcastManager, type BroadcastManager } from '../broadcasting'

/**
 * Binds the BroadcastManager as a singleton in the container and, at boot,
 * makes it the global one behind `getBroadcastManager()`.
 */
export class BroadcastServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('broadcast', () => createBroadcastManager())
  }

  boot(): void {
    setBroadcastManager(this.container.make<BroadcastManager>('broadcast'))
  }
}
