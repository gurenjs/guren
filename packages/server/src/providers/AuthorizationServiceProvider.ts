import { ServiceProvider } from '../container/ServiceProvider'
import { createGate, setGate } from '../authorization'

/**
 * Binds the Gate as a singleton and sets it as the global gate, so `getGate()`,
 * `can()`, and the controller authorization helpers need no manual wiring.
 */
export class AuthorizationServiceProvider extends ServiceProvider {
  register(): void {
    const gate = createGate()
    setGate(gate)
    this.container.singleton('gate', () => gate)
  }
}
