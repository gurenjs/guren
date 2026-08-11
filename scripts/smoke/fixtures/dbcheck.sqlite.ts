import { Database } from 'bun:sqlite'

const db = new Database('./data/guren.db')
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
for (const required of ['users', 'posts', 'comments', '__drizzle_migrations']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    // An empty table list here usually means db:migrate wrote somewhere else
    // rather than that it silently executed nothing, so name both databases.
    console.error('Checked sqlite file: ./data/guren.db (DATABASE_URL=' + (process.env.DATABASE_URL ?? '<unset>') + ')')
    process.exit(1)
  }
}
console.log('DB tables OK: ' + tables.join(', '))
