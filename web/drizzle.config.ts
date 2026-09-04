import { defineConfig } from 'drizzle-kit'

/**
 * The same variable `config/database.ts` reads, and not `DATABASE_URL`: that
 * name carries a Postgres URI in existing environments, which would point
 * drizzle-kit at a different database than the app opens.
 */
const filename = process.env.SQLITE_DATABASE_PATH ?? './data/guren.db'

/**
 * Two SQLite implementations read this and disagree about URI filenames:
 * `bun:sqlite` (the app) honours them, `node:sqlite` (drizzle-kit) does not, so
 * `file:local.db` migrates the app into `local.db` and drizzle-kit into a file
 * *named* `file:local.db`. Both agree only on plain paths and `:memory:`, so any
 * scheme of two characters or more is refused (`C:/…` is a Windows drive path).
 */
const uriScheme = /^([a-z][a-z0-9+.-]+):/i.exec(filename)

if (uriScheme) {
  throw new Error(
    `SQLITE_DATABASE_PATH must be a plain file path, but starts with "${uriScheme[1]}:". ` +
      (uriScheme[1].toLowerCase() === 'file'
        ? 'drizzle-kit reads a `file:` URI as a literal filename while the app resolves it ' +
          'as a URI, so the two would open different databases. Drop the scheme.'
        : 'This app runs on SQLite locally and D1 in production through the wrangler ' +
          'binding — there is no connection string.'),
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
