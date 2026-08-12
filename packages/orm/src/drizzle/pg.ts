// PostgreSQL dialect barrel: re-exports `drizzle-orm/pg-core` wholesale, so
// every builder a Postgres schema needs is here and each name can only mean
// the Postgres one (see ../drizzle.ts and #379 for the mixed-barrel trap
// this replaces).
export * from 'drizzle-orm/pg-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
