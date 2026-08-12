import { Database } from 'bun:sqlite'

import { MIGRATION_TRACKER, assertRequiredTables, assertTrackerNonEmpty } from './expected-tables.ts'

const DB_FILE = './data/guren.db'

// An empty table list usually means db:migrate wrote somewhere else rather than
// that it silently executed nothing, so every failure here names both databases.
const WHERE = 'Checked sqlite file: ' + DB_FILE + ' (DATABASE_URL=' + (process.env.DATABASE_URL ?? '<unset>') + ')'

const db = new Database(DB_FILE)
const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => (row as { name: string }).name)

assertRequiredTables(tables, WHERE)

// Same policy as the other two dialects: the tracker must exist *and* be
// non-empty. Presence is checked explicitly here only because sqlite_master is
// already in hand and yields a better message than the failing count query that
// stands in for this check on postgres and mysql.
if (!tables.includes(MIGRATION_TRACKER)) {
  console.error('Missing migration tracker after db:migrate: ' + MIGRATION_TRACKER)
  console.error(WHERE)
  process.exit(1)
}
const tracker = db.query(`SELECT count(*) AS c FROM \`${MIGRATION_TRACKER}\``).get()
assertTrackerNonEmpty(Number((tracker as { c: number } | null)?.c), MIGRATION_TRACKER)

console.log('DB tables OK (sqlite): ' + tables.join(', '))
