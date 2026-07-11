---
"@guren/orm": patch
---

Fix array values in object-form `where()` producing `eq(column, array)` instead of an IN clause. On bun:sqlite this threw "SQLite query expected 1 values, received N" whenever an eager load (`Model.with(...)`) ran against two or more parent records; with a single value it silently used wrong equality semantics. `where({ id: [1, 2] })`, `where('id', [1, 2])`, and the `orWhere` equivalents now compile to `IN`, matching `whereIn()`. Adds a real bun:sqlite integration test suite for relations, which fake-adapter tests could not cover.
