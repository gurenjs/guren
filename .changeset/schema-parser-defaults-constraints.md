---
"@guren/cli": minor
---

`parseSchemaTables()` reads more of a Drizzle schema (groundwork for RFC 0030).
`SchemaColumn` gains `unique` and `default` (the argument as written, never
evaluated: `value`, `sql`, `now`, `random`, or a `runtime` `$defaultFn`).
`SchemaTable` gains `constraints`, read from the factory's extra-config
callback in both its array and object forms: `index`, `uniqueIndex`, `unique`,
`primaryKey`, `foreignKey` and `check`, each with its name and column property
names. What the parser cannot follow is marked instead of reading as absent:
`opaqueBuilder` on a column whose chain does not start at a builder imported
from drizzle, `opaqueColumns` on a table whose columns carry a spread or a
computed key, `opaqueConstraints` on an extra config built elsewhere, and
`opaqueColumns` / `opaqueName` on a constraint written with expressions.
