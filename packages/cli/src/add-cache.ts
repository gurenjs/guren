import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { wireProviders } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type WriterOptions } from './utils'

const ENV_EXAMPLE = '.env.example'

/**
 * `guren add cache`: the cache provider and an example service, plus the
 * `CACHE_STORE` entry the provider reads. An app has no 'cache' binding of its
 * own until this runs, which is why the scaffolded .env.example ships no
 * CACHE_STORE line for it to read.
 */
export async function addCache(options: WriterOptions): Promise<string[]> {
  const created = await writeScaffoldFiles([
    scaffoldTemplateFile('cache', 'app/Providers/CacheProvider.ts'),
    scaffoldTemplateFile('cache', 'app/Services/ApplicationCache.ts'),
  ], options)

  await wireProviders([
    { name: 'CoreCacheServiceProvider', importStatement: "import { CacheServiceProvider as CoreCacheServiceProvider } from '@guren/core'" },
    { name: 'CacheProvider' },
  ])

  await patchEnvExample()

  return created
}

/**
 * Appended rather than rewritten: an app may already carry a value, and the
 * scaffolded .env.example ships none until this blueprint runs.
 */
async function patchEnvExample(): Promise<void> {
  const existing = await readIfExists(process.cwd(), ENV_EXAMPLE)
  if (existing === null) {
    consola.info('No .env.example found — set CACHE_STORE=memory in your environment.')
    return
  }

  if (/^\s*#?\s*CACHE_STORE=/m.test(existing)) {
    consola.info('.env.example already mentions CACHE_STORE — left unchanged.')
    return
  }

  const entry = [
    '',
    '# Which store CacheProvider uses. `redis` needs REDIS_URL.',
    'CACHE_STORE=memory',
    '# CACHE_STORE=redis',
    '',
  ].join('\n')

  await writeFile(resolve(process.cwd(), ENV_EXAMPLE), `${existing.trimEnd()}\n${entry}`, 'utf8')
  consola.info('Added CACHE_STORE to .env.example.')
}
