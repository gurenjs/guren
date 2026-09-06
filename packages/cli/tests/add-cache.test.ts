import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { APP_FIXTURE, createTempWorkspace, type TempWorkspace } from './helpers'
import { runBlueprint } from '../src/blueprints'

async function seedApp(env?: string): Promise<void> {
  await mkdir('src', { recursive: true })
  await writeFile('src/app.ts', APP_FIXTURE)
  if (env !== undefined) {
    await writeFile('.env.example', env)
  }
}

describe('guren add cache', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-add-cache-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('scaffolds a provider that selects its store from CACHE_STORE', async () => {
    await seedApp('APP_KEY=\n')

    await runBlueprint('cache', {})

    const provider = await readFile(resolve('app/Providers/CacheProvider.ts'), 'utf8')
    expect(provider).toContain("default: process.env.CACHE_STORE ?? 'memory'")
    expect(provider).toContain("memory: { driver: 'memory' }")
    // Both stores are declared once; `client` is a function because an entry's
    // options are evaluated with the config object and ioredis dials on
    // construction, so an unselected redis store would connect on every boot.
    expect(provider).toMatch(/stores:[\s\S]*driver: 'redis'/)
    expect(provider).toContain("client: () => createRedisClient({ url: process.env.REDIS_URL })")
    expect(provider).not.toContain('registerStore')

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain('CacheProvider')
  })

  it('appends the CACHE_STORE entry to .env.example', async () => {
    await seedApp('APP_KEY=\nREDIS_URL=\n')

    await runBlueprint('cache', {})

    const env = await readFile(resolve('.env.example'), 'utf8')
    expect(env).toContain('CACHE_STORE=memory')
    expect(env).toContain('# CACHE_STORE=redis')
    expect(env).toContain('APP_KEY=')
  })

  it('leaves an .env.example that already mentions CACHE_STORE unchanged', async () => {
    const existing = 'APP_KEY=\n# CACHE_STORE=redis\n'
    await seedApp(existing)

    await runBlueprint('cache', {})

    expect(await readFile(resolve('.env.example'), 'utf8')).toBe(existing)
  })

  it('scaffolds the provider when the app has no .env.example', async () => {
    await seedApp()

    await runBlueprint('cache', {})

    const provider = await readFile(resolve('app/Providers/CacheProvider.ts'), 'utf8')
    expect(provider).toContain('CACHE_STORE')
  })
})
