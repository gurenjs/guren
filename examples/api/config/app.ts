import { configureOrm, hasSeeders, seedDatabase } from './database.js'

let bootstrapped = false

export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  await configureOrm()
  if (hasSeeders) {
    await seedDatabase()
  }
  bootstrapped = true
}
