import { appendEnvEntry } from './env-registrar'
import { installsConfigDefinition, wireConfig, wireProviders } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * `guren add cache`: the cache configuration and an example service, plus the
 * `CACHE_STORE` entry it reads. An app declaring its environment in
 * `config/env.ts` gets a `config/cache.ts` definition (RFC 0027 §2); otherwise
 * `CacheProvider` (see {@link installsConfigDefinition}).
 */
export async function addCache(options: WriterOptions): Promise<string[]> {
  const declaresEnv = await installsConfigDefinition('cache')

  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  const created = await writeScaffoldFiles([
    declaresEnv
      ? scaffoldTemplateFile('cache', 'config/cache.ts')
      : scaffoldTemplateFile('cache', 'app/Providers/CacheProvider.ts'),
    scaffoldTemplateFile('cache', 'app/Services/ApplicationCache.ts'),
  ], { ...options, skipExisting: true })

  if (declaresEnv) {
    await wireConfig('cache')
  } else {
    await wireProviders([
      { name: 'CoreCacheServiceProvider', importStatement: "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'" },
      { name: 'CacheProvider' },
    ])
  }

  await appendEnvEntry('CACHE_STORE', `
# Which cache store the app uses. Declare it in the cache config before naming it here.
CACHE_STORE=memory
`, { declare: true })

  return created
}
