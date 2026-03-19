import { ServiceProvider } from '../container/ServiceProvider'
import { inertia } from '../mvc/inertia/InertiaEngine'
import { ViewEngine } from '../mvc/ViewEngine'

/**
 * Registers the Inertia view engine.
 */
export class InertiaServiceProvider extends ServiceProvider {
  register(): void {
    if (!ViewEngine.has('inertia')) {
      ViewEngine.register('inertia', inertia)
    }
  }
}
