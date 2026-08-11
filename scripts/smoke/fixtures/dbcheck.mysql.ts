import { createConnection } from 'mysql2/promise'

const connection = await createConnection(process.env.DATABASE_URL ?? '')
const [rows] = await connection.query(
  'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
)
const tables = (rows as Array<{ name: string }>).map((row) => row.name)
for (const required of ['users', 'posts', 'comments']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    process.exit(1)
  }
}
// The tracker table lives in the app database on MySQL, so the count below
// doubles as its existence check — the query fails if it was never created.
const [tracker] = await connection.query('SELECT count(*) AS c FROM __drizzle_migrations')
if (Number((tracker as Array<{ c: number }>)[0].c) < 1) {
  console.error('__drizzle_migrations is empty after db:migrate')
  process.exit(1)
}
await connection.end()
console.log('DB tables OK (mysql): ' + tables.join(', '))
