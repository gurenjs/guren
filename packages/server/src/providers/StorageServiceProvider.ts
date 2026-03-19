import { ServiceProvider } from '../container/ServiceProvider'
import { createStorageManager } from '../storage'

/**
 * Binds the StorageManager as a singleton in the container.
 */
export class StorageServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('storage', () => createStorageManager())
  }
}
