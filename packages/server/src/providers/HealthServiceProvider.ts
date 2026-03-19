import { ServiceProvider } from '../container/ServiceProvider'
import { createHealthManager } from '../health'

/**
 * Binds the HealthManager as a singleton in the container.
 */
export class HealthServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('health', () => createHealthManager())
  }
}
