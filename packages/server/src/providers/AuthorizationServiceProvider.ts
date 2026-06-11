import { ServiceProvider } from '../container/ServiceProvider'
import { createGate, setGate } from '../authorization'

/**
 * Binds the Gate as a singleton in the container and exposes it as the
 * global gate so `getGate()`, `can()`, and controller authorization helpers
 * work without manual wiring.
 */
export class AuthorizationServiceProvider extends ServiceProvider {
  register(): void {
    const gate = createGate()
    setGate(gate)
    this.container.singleton('gate', () => gate)
  }
}
