---
"@guren/cli": patch
---

**A scaffolded table now reaches the schema's aggregate object** — an app may keep `export const schema = { posts, users }` in its `db/schema.ts` and hand `typeof schema` to drizzle for relational queries. Nothing the framework generates reads that object, so when a scaffolder appended its table at end of file the aggregate was left silently incomplete: the app compiles, the table exists, and only the app's own consumer sees the gap. `examples/blog` hit exactly this.

`appendTableToSchema()` is now the one rule for writing a table into a `db/schema.ts`, and `guren add session`, `guren add attachments`, `guren make:auth` and `guren add resource` (which backs `make:feature`) all go through it — the last two each had their own end-of-file append. When the app keeps an aggregate, the identifier goes in and the declaration is spliced **ahead** of the object, since a `const` naming a table declared further down the file is a use before declaration (TS2448).

Detection is positive evidence only: every property must be a shorthand (or `name: name`) reference to a table the same file declares. Anything else, an ambiguous second candidate, or no such object at all appends exactly as before and says nothing. A schema that already declares the table but omits the key is reported rather than repaired, with the advice branching on whether that declaration sits above or below the object.

`make:module` re-exports a module's schema wholesale (`export * from …`) and so has no identifier to contribute; that case still needs a spread rather than a key.
