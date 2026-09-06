import { configureOrm } from './database'

let bootstrapped = false

/**
 * Seeding is one-shot provisioning, not part of booting: a Worker boots again
 * on every cold start, and the bundle cannot resolve `db/seeders/*.ts` anyway.
 * Run `bun run db:seed`, or POST the operator routes.
 */
export async function bootModels(): Promise<void> {
  if (bootstrapped) return

  await configureOrm()
  bootstrapped = true
}
