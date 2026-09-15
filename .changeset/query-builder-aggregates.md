---
"@guren/orm": minor
"@guren/core": minor
"@guren/cli": minor
---

The query builder gains `sum()`, `avg()`, `min()`, `max()` and `exists()`. They apply the model's global scopes, `SoftDeletes` included, the way `get()` does. A sum keeps the column's type: `numeric`/`decimal` columns come back as a string and `bigint({ mode: 'bigint' })` columns as a bigint, so no digit is lost. `toSql()` returns the scoped conditions as a Drizzle `SQL` fragment, and `toDrizzle()` starts a Drizzle select with them applied, or applies them to a select you pass (joins included), along with the builder's `orderBy()`, `limit()` and `offset()`. A later `.where()` on that select is AND-ed with the scopes instead of replacing them. `@guren/core` re-exports the new `AggregateFunction`, `SumValue`, `AvgValue` and `DrizzleSelectQuery` types.

### Deprecated

- **`Model.query()`**: returns a Drizzle select that skips every global scope, so it reads soft-deleted rows and other tenants' rows. Use `Model.newQuery().toDrizzle()`, or `toDrizzle(query)` for joins. Deprecated in `@guren/orm` 2.11.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `model-query-raw`.
