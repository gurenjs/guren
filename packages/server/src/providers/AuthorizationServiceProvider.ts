import { ServiceProvider } from '../container/ServiceProvider'
import { createGate } from '../authorization'

/**
 * Binds the Gate as a singleton in the container.
 */
export class AuthorizationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('gate', () => createGate())
  }
}
