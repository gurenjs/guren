import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  // `guren make:module` wires each modules/<name>/db/schema.ts into this
  // file automatically via a re-export, so this single path is enough by
  // default. If you'd rather point drizzle-kit at every module schema
  // directly instead, `schema` also accepts an array of paths/globs, e.g.
  // schema: ['./db/schema.ts', './modules/*/db/schema.ts'].
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren',
  },
})
