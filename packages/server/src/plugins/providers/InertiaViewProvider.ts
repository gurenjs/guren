import { inertia } from '../../mvc/inertia/InertiaEngine'
import { ViewEngine } from '../../mvc/ViewEngine'
import type { Provider } from '../Provider'
import type { ApplicationContext } from '../ApplicationContext'

export class InertiaViewProvider implements Provider {
  register(_context: ApplicationContext): void {
    if (!ViewEngine.has('inertia')) {
      ViewEngine.register('inertia', inertia)
    }
  }
}
