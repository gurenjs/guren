// What every dialect's `dbcheck` must find after `db:migrate`, and the one
// place that says so.
//
// The three dbcheck fixtures next to this file speak different dialects —
// different client, different catalog query, different home for the migration
// tracker — but the *policy* they enforce is identical, and that is the part
// that drifted while each held its own copy of it: sqlite folded the tracker
// into its required-table list and so only checked that it existed, while
// postgres and mysql counted its rows. One copy of the policy, three of the SQL.

// The tables `scripts/smoke-golden-path.sh` scaffolds before it runs a dbcheck:
// `add auth` -> users, `add resource posts` -> posts, `add resource comments`
// -> comments. Extend this when the smoke scaffolds another resource; it is a
// subset assertion, so unrelated tables the scaffolds emit are ignored.
export const REQUIRED_APP_TABLES = ['users', 'posts', 'comments'] as const

// Drizzle's migration bookkeeping table. Deliberately *not* a member of
// REQUIRED_APP_TABLES: its mere presence is a side effect of opening the
// migrator and can be true with zero migrations applied, which is precisely
// the failure these checks exist to catch (`db:migrate` reporting success while
// silently executing nothing). It is verified by counting its rows instead —
// see assertTrackerNonEmpty.
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
 *
 * Existence is the caller's business: the `SELECT count(*)` it runs fails on its
 * own when the tracker was never created.
 *
 * @param count Row count returned by the caller's query.
 * @param location How to name the tracker in the failure message; dialects
 *   qualify it differently (a `drizzle` schema on postgres, the app database on
 *   mysql, the app's file on sqlite).
 */
export function assertTrackerNonEmpty(count: number, location: string): void {
  if (!Number.isFinite(count) || count < 1) {
    console.error(location + ' is empty after db:migrate')
    process.exit(1)
  }
}

/**
 * Returns DATABASE_URL, refusing to fall back to a guess.
 *
 * A default here is a fail-open: the postgres fixture used to default to the
 * *development* database while the smoke exports a dedicated one, so an unset
 * URL would have quietly inspected a database no migration under test had
 * touched — and passed.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set — refusing to guess which database to inspect')
    process.exit(1)
  }
  return url
}
