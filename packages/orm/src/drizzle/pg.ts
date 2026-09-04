// PostgreSQL dialect barrel: re-exports `drizzle-orm/pg-core` wholesale, so
// each name can only mean the Postgres one (see ../drizzle.ts and #379).
export * from 'drizzle-orm/pg-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
