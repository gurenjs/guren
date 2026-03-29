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
