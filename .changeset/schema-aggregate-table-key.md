---
"@guren/cli": patch
---

**A scaffolded table now reaches the schema's aggregate object** — `guren add session` and `guren add attachments` appended their table at end of file, so an app that also maintains `export const schema = { posts, users }` — what `examples/blog`, `examples/api` and `examples/agents` each keep by hand and hand to drizzle as `typeof schema` — was left with an aggregate missing the new table. Silently: the app compiles and the table exists, and only whatever later consumes the aggregate (drizzle relational queries, say) sees the gap.

`appendSchemaTable()` now looks for that object and, on positive evidence, adds the identifier to it and splices the declaration **ahead** of it — a `const` naming a table declared further down the file is a use before declaration. Detection requires every property to be a shorthand (or `name: name`) reference to a table the same file declares; anything else, an ambiguous second candidate, or no such object at all appends exactly as before and says nothing. `make:feature` prints its table for the user to add and `make:module` re-exports a module's schema wholesale, so neither has a name to contribute here.
