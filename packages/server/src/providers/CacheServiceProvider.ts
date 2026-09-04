import { ServiceProvider } from '../container/ServiceProvider'
import { createCacheManager } from '../cache'

/** Binds the CacheManager as a singleton in the container. */
export class CacheServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => createCacheManager())
  }
}
