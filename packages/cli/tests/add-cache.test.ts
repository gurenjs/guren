import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { APP_FIXTURE, createTempWorkspace, type TempWorkspace } from './helpers'
import { fileExists } from '../src/discovery'
import { runBlueprint } from '../src/blueprints'

async function seedApp(env?: string): Promise<void> {
  await mkdir('src', { recursive: true })
  await writeFile('src/app.ts', APP_FIXTURE)
  if (env !== undefined) {
    await writeFile('.env.example', env)
    await writeFile('.env', env)
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
    // The redis store is documented in a comment rather than declared:
    // importing createRedisClient pulls ioredis into every bundle, on a runtime
    // that may never select it.
    expect(provider).not.toMatch(/^import .*createRedisClient/m)

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain('CacheProvider')
  })

  // .env is the file the app reads; .env.example alone would document a knob
  // the running app never sees.
  it('appends the CACHE_STORE entry to both env files', async () => {
    await seedApp('APP_KEY=\nREDIS_URL=\n')

    await runBlueprint('cache', {})

    for (const file of ['.env.example', '.env']) {
      const env = await readFile(resolve(file), 'utf8')
      expect(env).toContain('CACHE_STORE=memory')
      expect(env).toContain('APP_KEY=')
    }
  })

  it('leaves an env file that already mentions CACHE_STORE unchanged', async () => {
    const existing = 'APP_KEY=\n# CACHE_STORE=redis\n'
    await seedApp(existing)

    await runBlueprint('cache', {})

    expect(await readFile(resolve('.env.example'), 'utf8')).toBe(existing)
  })

  it('creates no env file for an app that has none', async () => {
    await seedApp()

    await runBlueprint('cache', {})

    expect(await fileExists(process.cwd(), '.env.example')).toBe(false)
  })

  it('repairs a re-run instead of throwing on the provider it already wrote', async () => {
    await seedApp('APP_KEY=\n')
    await runBlueprint('cache', {})
    await writeFile('.env.example', 'APP_KEY=\n')
    await writeFile('.env', 'APP_KEY=\n')

    await runBlueprint('cache', {})

    expect(await readFile(resolve('.env.example'), 'utf8')).toContain('CACHE_STORE=memory')
  })
})
