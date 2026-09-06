import { appendEnvEntry } from './env-registrar'
import { wireProviders } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * `guren add cache`: the cache provider and an example service, plus the
 * `CACHE_STORE` entry the provider reads. An app has no 'cache' binding of its
 * own until this runs, which is why the scaffolded .env files ship no
 * CACHE_STORE line for it to read.
 */
export async function addCache(options: WriterOptions): Promise<string[]> {
  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  const created = await writeScaffoldFiles([
    scaffoldTemplateFile('cache', 'app/Providers/CacheProvider.ts'),
    scaffoldTemplateFile('cache', 'app/Services/ApplicationCache.ts'),
  ], { ...options, skipExisting: true })

  await wireProviders([
    { name: 'CoreCacheServiceProvider', importStatement: "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'" },
    { name: 'CacheProvider' },
  ])

  await appendEnvEntry('CACHE_STORE', `
# Which store CacheProvider uses. Declare it there before naming it here.
CACHE_STORE=memory
`)

  return created
}
