import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { suggestNextSteps } from '../src/doctor'
import { detectConfigMigrations } from '../src/config-migration'
import { createTempWorkspace, linkWorkspaceCore, type TempWorkspace, writeWorkspaceFiles } from './helpers'

const SCAFFOLD = resolve(import.meta.dir, '../templates/scaffold')
const PROVIDER_SERVICES = ['cache', 'mail', 'queue', 'storage'] as const

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-config-migration-')
})

afterEach(async () => {
  await workspace.cleanup()
})

async function seedProviderForms(): Promise<void> {
  for (const service of PROVIDER_SERVICES) {
    await cp(join(SCAFFOLD, service, 'app'), join(workspace.dir, 'app'), { recursive: true })
  }
}

/**
 * Boots the written definitions in a fresh process, so the app's own `@guren/core`
 * link resolves them. Values go through `env.source`, which only the schema reads:
 * a definition still reading `process.env` would not see them.
 */
function bootDefinitions(source: Record<string, string>): Record<string, string> {
  const script = `
import { createApp } from '@guren/core'
import env from './config/env.ts'
${PROVIDER_SERVICES.map((service) => `import ${service} from './config/${service}.ts'`).join('\n')}
const app = createApp({ env, config: [${PROVIDER_SERVICES.join(', ')}] })
app.container.instance('env.source', ${JSON.stringify(source)})
await app.boot()
const make = (key) => app.container.make(key)
console.log(JSON.stringify({
  cache: make('cache').getDefaultStoreName(),
  mail: make('mail').getDefaultTransportName(),
  queue: make('queue').getDefaultDriverName(),
  storage: make('storage').getDefaultDiskName(),
}))
process.exit(0)
`
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: workspace.dir,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`boot failed:\n${result.stderr}`)
  return JSON.parse(result.stdout.toString().trim().split('\n').pop() ?? '{}') as Record<string, string>
}

describe('guren doctor --next config migration (RFC 0027 Migration Path)', () => {
  it('writes definitions that boot with the values the scaffolded providers declared', async () => {
    await seedProviderForms()
    await linkWorkspaceCore(workspace.dir)

    const steps = await suggestNextSteps({ cwd: workspace.dir })
    const migrationSteps = steps.filter((step) => step.filePath?.startsWith('config/'))
    expect(migrationSteps.map((step) => step.title)).toEqual([
      'Create config/env.ts',
      'Move cache configuration to config/cache.ts',
      'Move mail configuration to config/mail.ts',
      'Move queue configuration to config/queue.ts',
      'Move storage configuration to config/storage.ts',
    ])
    expect(migrationSteps.find((step) => step.filePath === 'config/queue.ts')?.description).toContain('registerJob()')
    expect(migrationSteps.find((step) => step.filePath === 'config/storage.ts')?.description).toContain('boot-time name check')

    expect(migrationSteps[0]?.content).toContain("CACHE_STORE: Env.string().default('memory'),")
    expect(migrationSteps[0]?.content).toContain("STORAGE_DISK: Env.string().default('local'),")
    expect(migrationSteps[0]?.content).toContain('QUEUE_CONNECTION: Env.string().optional(),')

    for (const step of migrationSteps) {
      expect(step.content).toBeDefined()
      const target = join(workspace.dir, step.filePath!)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, step.content!)
    }

    expect(bootDefinitions({})).toEqual({ cache: 'memory', mail: 'log', queue: 'sync', storage: 'local' })
    expect(bootDefinitions({ CACHE_STORE: 'redis', MAIL_MAILER: 'memory', QUEUE_CONNECTION: 'memory', STORAGE_DISK: 'public' }))
      .toEqual({ cache: 'redis', mail: 'memory', queue: 'memory', storage: 'public' })
  })

  it('suggests nothing for an app already on definitions', async () => {
    for (const service of PROVIDER_SERVICES) {
      await cp(join(SCAFFOLD, service, 'definition'), workspace.dir, { recursive: true })
    }
    await cp(join(SCAFFOLD, 'session', 'definition'), workspace.dir, { recursive: true })

    expect(await detectConfigMigrations(workspace.dir)).toEqual([])
  })

  it('moves a SessionConfig object and its provider to a session definition', async () => {
    await cp(join(SCAFFOLD, 'session'), workspace.dir, { recursive: true, filter: (source) => !source.includes('/definition') })

    const [migration] = await detectConfigMigrations(workspace.dir)
    expect(migration?.key).toBe('session')
    expect(migration?.legacyFiles).toEqual(['config/session.ts', 'app/Providers/SessionProvider.ts'])
    expect(migration?.content).toContain("import { defineSessionConfig } from '@guren/core'")
    expect(migration?.content).toContain("import { sessions } from '../db/schema'")
    expect(migration?.content).toContain('default: env.SESSION_DRIVER,')
    expect(migration?.content).not.toContain('SessionConfig =')
    expect(migration?.env).toEqual([{ key: 'SESSION_DRIVER', builder: "Env.string().default('database')" }])
  })

  it('declares only the variables config/env.ts lacks', async () => {
    await seedProviderForms()
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': "import { defineEnv, Env } from '@guren/core'\n\nexport default defineEnv({\n  CACHE_STORE: Env.string().default('memory'),\n})\n",
    })

    const steps = await suggestNextSteps({ cwd: workspace.dir })
    const declare = steps.find((step) => step.filePath === 'config/env.ts')
    expect(declare?.title).toBe('Declare the variables the config definitions read')
    expect(declare?.content).not.toContain('CACHE_STORE')
    expect(declare?.content).toContain("MAIL_FROM_NAME: Env.string().default('Guren').allowEmpty(),")
  })

  it('points at bootModels() and still hints a provider whose config it cannot read', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/app.ts': "import { configureOrm, seedDatabase } from './database.js'\n\nexport async function bootModels(): Promise<void> {\n  await configureOrm()\n  await seedDatabase()\n}\n",
      'app/Providers/DatabaseProvider.ts': "import { ServiceProvider } from '@guren/core'\nimport { bootModels } from '../../config/app.js'\n\nexport default class DatabaseProvider extends ServiceProvider {\n  async boot() { await bootModels() }\n}\n",
      'app/Providers/CacheProvider.ts': "import { ServiceProvider, createCacheManager } from '@guren/core'\nimport { cacheConfig } from '../../config/cache-options.js'\n\nexport default class CacheProvider extends ServiceProvider {\n  register(): void {\n    this.container.singleton('cache', () => createCacheManager(cacheConfig()))\n  }\n}\n",
    })

    const migrations = await detectConfigMigrations(workspace.dir)
    expect(migrations.map((migration) => [migration.key, migration.content === null])).toEqual([['cache', true], ['database', false]])
    expect(migrations[1]?.legacyFiles).toEqual(['config/app.ts', 'app/Providers/DatabaseProvider.ts'])
    expect(migrations[1]?.content).toContain("export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })")

    const steps = await suggestNextSteps({ cwd: workspace.dir })
    expect(steps.find((step) => step.filePath === 'config/cache.ts')?.description).toContain('could not be read')
    expect(await readFile(join(workspace.dir, 'app/Providers/CacheProvider.ts'), 'utf8')).toContain('createCacheManager(cacheConfig())')
  })
})
