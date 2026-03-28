import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { configureOrm, seedDatabase } from './database.js'

let bootstrapped = false
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../db/migrations', import.meta.url))

function hasMigrations(): boolean {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    return false
  }

  const entries = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
  return entries.some(
    (entry) => entry.isDirectory() && existsSync(resolve(MIGRATIONS_FOLDER, entry.name, 'migration.sql')),
  )
}

export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  // Always initialize ORM (even without migrations, models need a connection).
  // Only run seeders when migrations exist.
  await configureOrm()
  if (hasMigrations()) {
    await seedDatabase()
  }
  bootstrapped = true
}
