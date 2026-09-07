import { defineConfig } from 'drizzle-kit'

const filename = process.env.DATABASE_URL || './data/guren.db'

/**
 * DATABASE_URL is read by two different SQLite implementations that disagree
 * about URI filenames: the app opens it with `bun:sqlite`, which honours them,
 * while drizzle-kit opens it with `node:sqlite`, which does not. So `file:` is
 * not a shared spelling of anything — `file:local.db` migrates the app into
 * `local.db` and drizzle-kit into a file *named* `file:local.db`. The safe set
 * is what both agree on: plain paths, and `:memory:`.
 *
 * The scheme must be two characters or more, since no registered scheme is one
 * letter while `C:/data/app.db` is a Windows drive path.
 */
const uriScheme = /^([a-z][a-z0-9+.-]+):/i.exec(filename)

if (uriScheme) {
  throw new Error(
    `DATABASE_URL must be a plain file path for SQLite, but starts with "${uriScheme[1]}:". ` +
      'Point it at a file such as ./data/guren.db, or use ":memory:".',
  )
}

export default defineConfig({
  // `guren make:module` wires each modules/<name>/db/schema.ts into this
  // file automatically via a re-export, so this single path is enough by
  // default. If you'd rather point drizzle-kit at every module schema
  // directly instead, `schema` also accepts an array of paths/globs, e.g.
  // schema: ['./db/schema.ts', './modules/*/db/schema.ts'].
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: filename,
  },
})
