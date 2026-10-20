import { describe, test, expect } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createD1Database } from './d1'

function createStubBinding() {
  return {
    prepare(query: string) {
      // Sentinel proving a query reached the D1 client boundary.
      throw new Error(`stub-prepare:${query}`)
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

  test('should route queries through the binding client (positional drizzle invocation)', async () => {
    const database = createD1Database({ binding: createStubBinding })
    const db = (await database.getDatabase()) as { run(query: unknown): Promise<unknown> }

    // run() prepares synchronously; drizzle wraps the stub sentinel in a
    // DrizzleQueryError carrying the SQL text.
    expect(() => db.run(sql`select 1`)).toThrow(/Failed query: select 1/)
  })

  test('should share one in-flight initialization across concurrent getDatabase calls', async () => {
    let calls = 0
    const database = createD1Database({
      binding: () => {
        calls += 1
        return createStubBinding()
      },
    })

    const [first, second] = await Promise.all([database.getDatabase(), database.getDatabase()])

    expect(first).toBe(second)
    expect(calls).toBe(1)
  })

  test('should retry initialization after a failed binding resolution', async () => {
    let calls = 0
    const database = createD1Database({
      binding: () => {
        calls += 1
        return calls === 1 ? undefined : createStubBinding()
      },
    })

    await expect(database.getDatabase()).rejects.toThrow(/before the first request/)
    expect(await database.getDatabase()).toBeDefined()
    expect(calls).toBe(2)
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
  })

  test('should never leak an absolute path into the migrations guidance', async () => {
    const absoluteDir = new URL('.', import.meta.url).pathname
    const database = createD1Database({
      binding: createStubBinding,
      migrationsFolder: new URL('./migrations', import.meta.url),
    })

    const error = await database.migrateDatabase().catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('migrations')
    expect((error as Error).message).not.toContain(absoluteDir)
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

describe('createD1Database with a binding name (RFC 0035 §2.1)', () => {
  // The slot @guren/plugin-cloudflare/env captures the env into; plugin-cloudflare's env.test.ts pins the same key.
  const slot = Symbol.for('guren.workersEnv')
  const slots = globalThis as unknown as Record<symbol, { env: unknown } | undefined>

  test('should read the named binding from the captured Workers env, and report the name', async () => {
    const database = createD1Database({ binding: 'DB' })
    expect(database.describe()).toMatchObject({ dialect: 'd1', binding: 'DB' })

    await expect(database.getDatabase()).rejects.toThrow('"DB" binding was read before the first request')
    slots[slot] = { env: { DB: createStubBinding() } }
    try {
      await expect(database.getDatabase()).resolves.toBeDefined()
    } finally {
      slots[slot] = undefined
    }
  })

  test('should name the missing binding when the env lacks it, and report no name for a closure', async () => {
    slots[slot] = { env: {} }
    try {
      await expect(createD1Database({ binding: 'DB' }).getDatabase()).rejects.toThrow('the Workers env has no "DB" binding')
    } finally {
      slots[slot] = undefined
    }
    expect(createD1Database({ binding: () => createStubBinding() }).describe()).not.toHaveProperty('binding')
  })
})
