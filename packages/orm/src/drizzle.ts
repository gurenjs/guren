// PostgreSQL-first convenience re-exports: the unqualified column builders
// below (`text`, `timestamp`, `boolean`, …) are the pg-core ones. MySQL and
// SQLite schemas must import their builders from `drizzle-orm/mysql-core` /
// `drizzle-orm/sqlite-core` — mixing dialects here is silent, because the
// names collide and drizzle-kit still emits DDL for the wrong builder.
export { sql } from 'drizzle-orm'
export type { SQL } from 'drizzle-orm'

export {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export type {
  PgTable,
  PgColumn,
} from 'drizzle-orm/pg-core'

export {
  mysqlTable,
  int,
  varchar,
  datetime,
} from 'drizzle-orm/mysql-core'

export type {
  MySqlTable,
  MySqlColumn,
} from 'drizzle-orm/mysql-core'
