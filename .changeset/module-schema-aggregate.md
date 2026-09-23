---
'@guren/cli': patch
---

`guren make:module` keeps a root schema object complete. When `db/schema.ts` keeps an aggregate for drizzle (`export const schema = { … }`), the module's `db/schema.ts` gets its own (`export const billingSchema = {}`) and the root object spreads it. `guren check` now reports a module table the root object neither lists nor spreads, which it used to pass in silence, and no longer loses the root object when it spreads a module aggregate or lists a table imported from a module. The module re-export check reads `export … from` statements instead of any mention of the module's path, so an `import` alone no longer counts as the re-export.
