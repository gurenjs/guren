import { configureOrm, seedDatabase } from './database.js'

let bootstrapped = false

export async function bootModels(): Promise<void> {
  if (bootstrapped) {
    return
  }

  await configureOrm()
  await seedDatabase()
  bootstrapped = true
}
