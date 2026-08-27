import { ServiceProvider, createCacheManager } from '@guren/core'

export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => createCacheManager({
      default: 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    }))
  }
}
