import { ServiceProvider } from '../container/ServiceProvider'
import { createLogManager } from '../logging'

/**
 * Binds the LogManager as a singleton in the container.
 */
export class LogServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('log', () => createLogManager({ default: 'console', channels: {} }))
  }
}
