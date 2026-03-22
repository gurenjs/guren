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

  // v1: folder-based migrations
  const entries = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(resolve(MIGRATIONS_FOLDER, entry.name, 'migration.sql'))) {
      return true
    }
  }

  // v0: journal-based migrations
  return existsSync(resolve(MIGRATIONS_FOLDER, 'meta/_journal.json'))
}

export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  if (!hasMigrations()) {
    bootstrapped = true
    return
  }

  await configureOrm()
  await seedDatabase()
  bootstrapped = true
}
