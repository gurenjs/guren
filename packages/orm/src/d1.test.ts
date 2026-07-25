import { describe, test, expect } from 'bun:test'
import { createD1Database } from './d1'

function createStubBinding() {
  return {
    prepare() {
      throw new Error('not executed in tests')
    },
  }
}

describe('createD1Database', () => {
  test('should not call the binding resolver until getDatabase is used', () => {
    let calls = 0
    createD1Database({
      binding: () => {
        calls += 1
        return createStubBinding()
      },
    })

    expect(calls).toBe(0)
  })

  test('should build a drizzle instance from the binding and cache it', async () => {
    let calls = 0
    const database = createD1Database({
      binding: () => {
        calls += 1
        return createStubBinding()
      },
    })

    const first = await database.getDatabase()
    const second = await database.getDatabase()

    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  test('should throw a deferral hint when the binding resolves to nothing', async () => {
    const database = createD1Database({ binding: () => undefined })

    await expect(database.getDatabase()).rejects.toThrow(/before the first request/)
  })

  test('should drop the cached instance on closeDatabase', async () => {
    const database = createD1Database({ binding: createStubBinding })

    const first = await database.getDatabase()
    await database.closeDatabase()
    const second = await database.getDatabase()

    expect(second).not.toBe(first)
  })

  test('should reject runtime migrations with wrangler guidance', async () => {
    const database = createD1Database({
      binding: createStubBinding,
      migrationsFolder: new URL('./migrations', import.meta.url),
    })

    await expect(database.migrateDatabase()).rejects.toThrow(/wrangler d1 migrations apply/)
    await expect(database.migrateDatabase()).rejects.toThrow(/migrations/)
  })

  test('should reject runtime seeding with wrangler guidance', async () => {
    const database = createD1Database({ binding: createStubBinding })

    await expect(database.seedDatabase()).rejects.toThrow(/wrangler d1 execute/)
  })

  test('should reject runtime resets with wrangler guidance', async () => {
    const database = createD1Database({ binding: createStubBinding })

    await expect(database.resetDatabase()).rejects.toThrow(/wrangler d1 delete/)
  })

  test('should defer migration status to the wrangler tracker', async () => {
    const database = createD1Database({ binding: createStubBinding })

    await expect(database.migrationStatus()).rejects.toThrow(/wrangler d1 migrations list/)
  })

  test('should configure the ORM adapter without touching the binding client', async () => {
    const database = createD1Database({ binding: createStubBinding })

    await database.configureOrm()

    expect(await database.getDatabase()).toBeDefined()
  })
})
