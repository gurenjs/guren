import { configureOrm, seedDatabase } from './database.js'

let bootstrapped = false

/**
 * Seeding is one-shot provisioning, not part of booting: production boots
 * repeatedly on serverless cold starts, and a bundle has no resolver for the
 * raw db/seeders/*.ts files. Run `bun run db:seed` explicitly instead.
 */
function shouldSeedOnBoot(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  await configureOrm()
  if (shouldSeedOnBoot()) {
    await seedDatabase()
  }
  bootstrapped = true
}
