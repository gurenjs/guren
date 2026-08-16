import { defineConfig } from 'drizzle-kit'

/**
 * The same variable `config/database.ts` reads, and deliberately not
 * `DATABASE_URL`: that name carries a Postgres URI in existing environments,
 * so naming it here would point `drizzle-kit studio`/`push`/`migrate` at a
 * different database than the app itself opens.
 */
const filename = process.env.SQLITE_DATABASE_PATH ?? './data/guren.db'

/**
 * This variable is read by two different SQLite implementations that disagree
 * about URI filenames: the app opens it with `bun:sqlite`, which honours them,
 * while drizzle-kit opens it with `node:sqlite`, which does not. So `file:` is
 * not a shared spelling of anything — `file:local.db` migrates the app into
 * `local.db` and drizzle-kit into a file *named* `file:local.db`, which is the
 * silent split this variable exists to avoid. The safe set is what both agree
 * on: plain paths, and `:memory:`.
 *
 * Hence any scheme is refused, not just one carrying an authority. The scheme
 * must be two characters or more, since no registered scheme is one letter
 * while `C:/data/app.db` is a Windows drive path. `@guren/orm` applies a
 * narrower rule to the app's own filename, where `bun:sqlite` is the only
 * consumer and URI forms do work.
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
