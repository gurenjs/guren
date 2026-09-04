import { configureOrm, seedDatabase } from './database.js'

let bootstrapped = false

/**
 * Seeding is one-shot provisioning, not part of booting: production boots again
 * on every serverless cold start, and a bundle cannot resolve db/seeders/*.ts.
 * Run `bun run db:seed` explicitly instead.
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
