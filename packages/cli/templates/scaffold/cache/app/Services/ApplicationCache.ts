import type { CacheManager } from '@guren/core'

export class ApplicationCache {
  constructor(private readonly cache: CacheManager) {}

  async rememberVersion(): Promise<string> {
    return this.cache.store().rememberForever('app:version', async () => 'vNext')
  }
}
