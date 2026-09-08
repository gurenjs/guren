---
'@guren/cli': patch
---

Scaffolders that add a table to `db/schema.ts` now leave an aggregate object alone unless the file itself identifies it as the schema — named `schema`, or read in a `typeof`. On a bare shape match (`export const authTables = { users }`) the new table is appended at end of file with no key added and no declaration moved, the same evidence `guren check` already refuses to gate on.
