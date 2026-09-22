---
"@guren/cli": patch
---

The static schema reader now recognises column and constraint builders imported from `@guren/orm/drizzle/pg`, `/mysql`, `/sqlite` and the mixed `@guren/orm/drizzle` barrel, the imports every scaffolded app uses. It used to trust only `drizzle-orm/*` imports, so in a scaffolded app every column read as an unknown builder: the runtime schema reader could not attach the builder name to any column (`guren plan:status` judged column types from the SQL type alone), its static fallback reported column types and modifiers as unknown, and indexes and unique constraints in a table's extra config were not read.
