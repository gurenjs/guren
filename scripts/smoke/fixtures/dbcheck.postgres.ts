import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren', { max: 1 })
const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
const tables = rows.map((row) => row.table_name as string)
for (const required of ['users', 'posts', 'comments']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    process.exit(1)
  }
}
const tracker = await sql`SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations`
if (Number(tracker[0].c) < 1) {
  console.error('drizzle.__drizzle_migrations is empty after db:migrate')
  process.exit(1)
}

// Every timestamp a scaffold emits must carry a time zone. An offset-less
// column stores a bare wall clock and leaves its meaning to the reader: the
// app itself stays self-consistent (drizzle parses the column as UTC), which
// is why the smoke's later HTTP steps cannot catch this, but every other reader sees
// a different instant and a `defaultNow()` column records the DB session's
// local wall clock. Asked as "which columns are wrong" rather than against a
// list of names, so a scaffold that grows a new timestamp is covered too.
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
