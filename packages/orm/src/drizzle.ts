// Mixed-dialect barrel, kept for compatibility. Prefer `@guren/orm/drizzle/pg`
// `/mysql` `/sqlite`, where each name can only mean one thing. Here they
// collide: `varchar` is the MySQL builder, so a Postgres schema type-checks
// and then throws at import time (#379). The unqualified builders below
// (`text`, `timestamp`, …) are the pg-core ones.
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

// Re-exported as value declarations rather than `export { … } from` so the
// @deprecated JSDoc survives the dts rollup and reaches editors.
import {
  mysqlTable as mysqlCoreMysqlTable,
  int as mysqlCoreInt,
  varchar as mysqlCoreVarchar,
  datetime as mysqlCoreDatetime,
} from 'drizzle-orm/mysql-core'

/** @deprecated Import from `@guren/orm/drizzle/mysql` instead. */
export const mysqlTable: typeof mysqlCoreMysqlTable = mysqlCoreMysqlTable
/** @deprecated Import from `@guren/orm/drizzle/mysql` instead. */
export const int: typeof mysqlCoreInt = mysqlCoreInt
/**
 * @deprecated Import from `@guren/orm/drizzle/mysql` instead — or from
 * `@guren/orm/drizzle/pg` for the Postgres builder. This `varchar` is the
 * MySQL one: in a Postgres schema it type-checks and then throws
 * `TypeError: colBuilder.buildExtraConfigColumn is not a function` at
 * import time.
 */
export const varchar: typeof mysqlCoreVarchar = mysqlCoreVarchar
/** @deprecated Import from `@guren/orm/drizzle/mysql` instead. */
export const datetime: typeof mysqlCoreDatetime = mysqlCoreDatetime

// No @deprecated here: the dts rollup drops JSDoc on `export type { … } from`,
// and re-declaring the aliases would mean copying generic signatures from a
// drizzle RC. The value exports above carry the marker.
export type {
  MySqlTable,
  MySqlColumn,
} from 'drizzle-orm/mysql-core'
