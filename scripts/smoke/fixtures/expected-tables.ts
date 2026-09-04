// What every dialect's `dbcheck` must find after `db:migrate`, and the one
// place that says so.
//
// The three dbcheck fixtures next to this file speak different dialects (client,
// catalog query, home of the migration tracker) but enforce one policy, and a
// policy held in three copies drifts: sqlite folding the tracker into its
// required-table list checks only that it exists, while postgres and mysql count
// its rows. One copy of the policy, three of the SQL.

// The tables `scripts/smoke-golden-path.sh` scaffolds before it runs a dbcheck:
// `add auth` -> users, `add resource posts` -> posts, `add resource comments`
// -> comments. Extend this when the smoke scaffolds another resource; it is a
// subset assertion, so unrelated tables the scaffolds emit are ignored.
export const REQUIRED_APP_TABLES = ['users', 'posts', 'comments'] as const

// Drizzle's migration bookkeeping table. Deliberately *not* a member of
// REQUIRED_APP_TABLES: its presence is a side effect of opening the migrator and
// holds with zero migrations applied, which is precisely the failure these checks
// exist to catch (`db:migrate` reporting success while executing nothing). It is
// verified by counting its rows instead; see assertTrackerNonEmpty.
export const MIGRATION_TRACKER = '__drizzle_migrations'

/**
 * Asserts every required application table was created.
 *
 * @param tables Table names read from the dialect's catalog.
 * @param diagnostics Printed on failure, for what only the caller knows —
 *   which file was opened, which database was addressed.
 */
export function assertRequiredTables(tables: string[], diagnostics?: string): void {
  for (const required of REQUIRED_APP_TABLES) {
    if (!tables.includes(required)) {
      console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
      if (diagnostics) console.error(diagnostics)
      process.exit(1)
    }
  }
}

/**
 * Asserts the migration tracker recorded at least one applied migration.
 * Existence is the caller's business: its `SELECT count(*)` fails on its own
 * when the tracker was never created.
 * @param count Row count returned by the caller's query.
 * @param location How to name the tracker in the failure message; dialects qualify it differently.
 */
export function assertTrackerNonEmpty(count: number, location: string): void {
  if (!Number.isFinite(count) || count < 1) {
    console.error(location + ' is empty after db:migrate')
    process.exit(1)
  }
}

/**
 * Returns DATABASE_URL, refusing to fall back to a guess. A default here is a
 * fail-open: the smoke exports a dedicated database, so a fixture defaulting to
 * the *development* one would quietly inspect a database no migration under test
 * had touched, and pass.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set — refusing to guess which database to inspect')
    process.exit(1)
  }
  return url
}
