// MySQL dialect barrel: re-exports `drizzle-orm/mysql-core` wholesale (see
// ../drizzle.ts and #379 for the mixed-barrel trap this replaces).
export * from 'drizzle-orm/mysql-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
