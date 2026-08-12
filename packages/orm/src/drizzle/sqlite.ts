// SQLite dialect barrel: re-exports `drizzle-orm/sqlite-core` wholesale.
// The mixed-dialect `@guren/orm/drizzle` barrel never exported SQLite
// builders at all, so SQLite schemas had to import `drizzle-orm/sqlite-core`
// directly (see ./pg.ts and #379).
export * from 'drizzle-orm/sqlite-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
