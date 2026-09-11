import process from 'node:process'

/**
 * The parent environment a smoke hands a scaffolded app, minus DATABASE_URL.
 * Bun loads the app's .env without overriding what a parent passes, so a
 * job-level URL (nightly-canary.yml sets a Postgres one) outranks the scaffold's
 * SQLite path: drizzle-kit refuses it, no migration is generated, and the app
 * the smoke boots is not the one the scaffold configured.
 */
export function inheritedEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.DATABASE_URL
  return env
}
