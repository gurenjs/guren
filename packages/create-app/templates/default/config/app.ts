import { configureOrm, seedDatabase } from './database'

let bootstrapped = false

export async function bootModels(): Promise<void> {
  if (bootstrapped) {
    return
  }

  try {
    await configureOrm()
    await seedDatabase()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('Skipping ORM bootstrap:', reason)
  }

  bootstrapped = true
}
