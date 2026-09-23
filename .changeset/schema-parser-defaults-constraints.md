---
"@guren/cli": minor
---

`parseSchemaTables()` reads more of a Drizzle schema (groundwork for RFC 0030).
`SchemaColumn` gains `unique`, `default` (the database default as written,
never evaluated: `value`, `sql`, `now` or `random`) and `runtimeDefault` (the
source text of a `$defaultFn()` / `$default()` argument).
`SchemaTable` gains `constraints`, read from the factory's extra-config
callback in both its array and object forms: `index`, `uniqueIndex`, `unique`,
`primaryKey`, `foreignKey` and `check`, each with its name and column property
names. What the parser cannot follow is marked instead of reading as absent:
`opaqueBuilder` on a column whose chain does not start at a builder imported
from drizzle, `opaqueColumns` on a table whose columns carry a spread or a
computed key, `opaqueConstraints` on an extra config built elsewhere, and
`opaqueColumns` / `opaqueName` on a constraint written with expressions.
A column or a table declaration wrapped in `as` / `satisfies` is now read
instead of skipped, so the ER spec view shows such a column's real type.
