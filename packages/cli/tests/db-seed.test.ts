import { describe, expect, it, spyOn } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { dbSeed, dbSeedList } from '../src/db-seed'

describe('db-seed helpers', () => {
  it('runs the default seeder when present', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-run-')
    try {
      await mkdir(join(workspace.dir, 'db/seeders'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/seeders/DatabaseSeeder.ts'),
        `
export default class DatabaseSeeder {
  async run() {
    globalThis.__seeded = true
  }
}
`,
        'utf8',
      )

      await dbSeed({ silent: true })
      expect((globalThis as typeof globalThis & { __seeded?: boolean }).__seeded).toBe(true)
      delete (globalThis as typeof globalThis & { __seeded?: boolean }).__seeded
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses to run in production without force', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-prod-')
    const originalEnv = process.env.NODE_ENV
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)

    try {
      process.env.NODE_ENV = 'production'
      await expect(dbSeed()).rejects.toThrow('exit:1')
    } finally {
      process.env.NODE_ENV = originalEnv
      exitSpy.mockRestore()
      await workspace.cleanup()
    }
  })

  it('lists available seeders', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-list-')
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await mkdir(join(workspace.dir, 'db/seeders'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/seeders/DatabaseSeeder.ts'),
        'export default class DatabaseSeeder {}',
        'utf8',
      )

      await dbSeedList()
      expect(logSpy).toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      await workspace.cleanup()
    }
  })
})
