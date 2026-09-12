import { ServiceProvider } from '../container/ServiceProvider'
import { createGate } from '../authorization'

/**
 * Binds the Gate as a singleton. Controllers, the authorization middleware and
 * `getGate()` resolve it from there (RFC 0023 §4), so no global is written.
 */
export class AuthorizationServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('gate', () => createGate())
  }
}
