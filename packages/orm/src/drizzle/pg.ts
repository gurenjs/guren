// PostgreSQL dialect barrel: re-exports `drizzle-orm/pg-core` wholesale, so
// every builder a Postgres schema needs (`varchar`, `index`, `primaryKey`,
// `pgEnum`, …) is here and each name can only mean the Postgres one. The
// mixed-dialect `@guren/orm/drizzle` barrel resolves colliding names
// (`varchar`) to the MySQL builder, which type-checks in a Postgres schema
// and then throws at import time (#379).
export * from 'drizzle-orm/pg-core'
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'
