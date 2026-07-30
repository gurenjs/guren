import { configureOrm, isWorkersRuntime, seedDatabase } from './database.js'

let bootstrapped = false

async function hasMigrations(): Promise<boolean> {
  // On Workers there is no filesystem to probe — migrations are applied
  // out-of-band with `wrangler d1 migrations apply` and the ORM simply
  // connects to the already-migrated database.
  if (isWorkersRuntime()) {
    return true
  }

  const { existsSync, readdirSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

  if (!existsSync(migrationsFolder)) {
    return false
  }

  const entries = readdirSync(migrationsFolder, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(resolve(migrationsFolder, entry.name, 'migration.sql'))) {
      return true
    }
  }

  return existsSync(resolve(migrationsFolder, 'meta/_journal.json'))
}

export async function bootModels(): Promise<void> {
  if (bootstrapped) {
    return
  }

  if (!(await hasMigrations())) {
    bootstrapped = true
    return
  }

  try {
    await configureOrm()
    // D1 seeding is a CLI workflow (`wrangler d1 execute`); the factory's
    // seedDatabase() intentionally throws on Workers. Seeding is also one-shot
    // provisioning rather than part of booting, so it stays out of production
    // boots on every runtime — run `bunx guren db:seed` explicitly instead.
    if (!isWorkersRuntime() && process.env.NODE_ENV !== 'production') {
      await seedDatabase()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('Skipping ORM bootstrap:', reason)
  }

  bootstrapped = true
}
