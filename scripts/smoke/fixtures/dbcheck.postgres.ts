import postgres from 'postgres'

import {
  MIGRATION_TRACKER,
  assertRequiredTables,
  assertTrackerNonEmpty,
  requireDatabaseUrl,
} from './expected-tables.ts'

const sql = postgres(requireDatabaseUrl(), { max: 1 })
const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
const tables = rows.map((row) => row.table_name as string)
assertRequiredTables(tables)

// The tracker lives in its own `drizzle` schema on postgres, so it is absent
// from the `public` list above and gets its own query. Built with `unsafe`
// because the identifier helper would quote "drizzle.__drizzle_migrations" as a
// single name; the interpolated value is a constant in this repo, not input.
const tracker = await sql.unsafe(`SELECT count(*)::int AS c FROM drizzle."${MIGRATION_TRACKER}"`)
assertTrackerNonEmpty(Number(tracker[0].c), `drizzle.${MIGRATION_TRACKER}`)

// Every timestamp a scaffold emits must carry a time zone. An offset-less column
// stores a bare wall clock: the app stays self-consistent (drizzle parses it as
// UTC), which is why the smoke's later HTTP steps cannot catch this, but every
// other reader sees a different instant and `defaultNow()` records the DB session's
// local wall clock. Asked as "which columns are wrong", so a new timestamp is covered too.
const offsetlessColumns = await sql`
  SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE table_schema = 'public'
    AND data_type LIKE 'timestamp%'
    AND data_type <> 'timestamp with time zone'
`
if (offsetlessColumns.length > 0) {
  const named = offsetlessColumns.map((c) => c.table_name + '.' + c.column_name + ' (' + c.data_type + ')')
  console.error('Expected every timestamp column to be timestamptz, but found: ' + named.join(', '))
  process.exit(1)
}

await sql.end()
console.log('DB tables OK (postgres): ' + tables.join(', ') + ' — timestamp columns are timestamptz')
