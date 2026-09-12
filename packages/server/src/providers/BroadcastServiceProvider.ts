import { ServiceProvider } from '../container/ServiceProvider'
import { createBroadcastManager } from '../broadcasting'

/**
 * Binds the BroadcastManager as a singleton in the container;
 * `getBroadcastManager()` resolves it from the default application (RFC 0023 §4).
 */
export class BroadcastServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('broadcast', () => createBroadcastManager())
  }
}
