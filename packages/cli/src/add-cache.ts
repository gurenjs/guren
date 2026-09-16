import { installServiceScaffold } from './service-scaffold'
import type { WriterOptions } from './utils'

/**
 * `guren add cache`: the cache configuration and an example service, plus the
 * `CACHE_STORE` entry it reads.
 */
export async function addCache(options: WriterOptions): Promise<string[]> {
  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  return installServiceScaffold({
    key: 'cache',
    coreProvider: 'CacheServiceProvider',
    provider: 'CacheProvider',
    shared: ['app/Services/ApplicationCache.ts'],
    env: {
      key: 'CACHE_STORE',
      entry: `
# Which cache store the app uses. Declare it in the cache config before naming it here.
CACHE_STORE=memory
`,
    },
  }, { ...options, skipExisting: true })
}
