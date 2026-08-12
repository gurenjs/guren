// MySQL dialect barrel: re-exports `drizzle-orm/mysql-core` wholesale, so a
// MySQL schema imports every builder from one place and never picks up a
// Postgres builder under a colliding name (see ./pg.ts and #379).
export * from 'drizzle-orm/mysql-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
