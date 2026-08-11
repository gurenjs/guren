// CREATE DATABASE has no IF NOT EXISTS on pg, hence the explicit lookup.
import postgres from 'postgres'

const target = new URL(process.env.DATABASE_URL ?? '')
const dbName = target.pathname.slice(1)
const admin = new URL(target.toString())
admin.pathname = '/postgres'

const sql = postgres(admin.toString(), { max: 1 })
const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
if (exists.length === 0) {
  await sql.unsafe(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`)
  console.log(`Created database ${dbName}`)
} else {
  console.log(`Database ${dbName} already exists`)
}
await sql.end()
