---
'@guren/orm': minor
---

Add per-dialect drizzle barrels: `@guren/orm/drizzle/pg`, `@guren/orm/drizzle/mysql`, and `@guren/orm/drizzle/sqlite`, each re-exporting its dialect's builders wholesale (plus `sql`).

The mixed `@guren/orm/drizzle` barrel exports both dialects into one namespace, so `varchar` resolves to the MySQL builder — a Postgres schema using it type-checks and then throws `TypeError: colBuilder.buildExtraConfigColumn is not a function` at import time. The barrel was also missing builders every real schema needs (`index`, `primaryKey`, `pgEnum`, `unique`, `numeric`, `date`, …), forcing split imports from `drizzle-orm/pg-core`.

The mixed barrel is unchanged for compatibility; its MySQL exports (`mysqlTable`, `int`, `varchar`, `datetime`) are now marked `@deprecated` pointing at `@guren/orm/drizzle/mysql`.
