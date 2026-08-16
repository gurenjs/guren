import { defineConfig } from 'drizzle-kit'

/**
 * The same variable `config/database.ts` reads, and deliberately not
 * `DATABASE_URL`: that name carries a Postgres URI in existing environments,
 * so naming it here would point `drizzle-kit studio`/`push`/`migrate` at a
 * different database than the app itself opens.
 */
const filename = process.env.SQLITE_DATABASE_PATH ?? './data/guren.db'

/**
 * `file:local.db` and `:memory:` are legitimate sqlite values, so this matches
 * only a scheme *with* an authority — the shape of a connection string that
 * sqlite would otherwise silently accept as a filename.
 */
const uriScheme = /^([a-z+]+):\/\//i.exec(filename)

if (uriScheme) {
  throw new Error(
    `SQLITE_DATABASE_PATH must be a file path, but starts with "${uriScheme[1]}://". ` +
      'This app runs on SQLite locally and D1 in production through the wrangler ' +
      'binding — there is no connection string.',
  )
}

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: filename,
  },
})
