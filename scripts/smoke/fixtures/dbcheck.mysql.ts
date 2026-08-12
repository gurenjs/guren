import { createConnection } from 'mysql2/promise'

import {
  MIGRATION_TRACKER,
  assertRequiredTables,
  assertTrackerNonEmpty,
  requireDatabaseUrl,
} from './expected-tables.ts'

const connection = await createConnection(requireDatabaseUrl())
const [rows] = await connection.query(
  'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
)
const tables = (rows as Array<{ name: string }>).map((row) => row.name)
assertRequiredTables(tables)

// The tracker table lives in the app database on MySQL, so this count doubles as
// its existence check — the query fails if it was never created.
const [tracker] = await connection.query(`SELECT count(*) AS c FROM \`${MIGRATION_TRACKER}\``)
assertTrackerNonEmpty(Number((tracker as Array<{ c: number }>)[0].c), MIGRATION_TRACKER)
await connection.end()
console.log('DB tables OK (mysql): ' + tables.join(', '))
