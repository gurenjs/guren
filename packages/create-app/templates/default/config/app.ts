import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configureOrm, seedDatabase } from './database.js'

let bootstrapped = false
const MIGRATION_JOURNAL_PATH = fileURLToPath(new URL('../db/migrations/meta/_journal.json', import.meta.url))

export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  if (!existsSync(MIGRATION_JOURNAL_PATH)) {
    bootstrapped = true
    return
  }

  await configureOrm()
  await seedDatabase()
  bootstrapped = true
}
