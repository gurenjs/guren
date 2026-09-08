---
"@guren/cli": patch
---

**`guren check` now reports a `db/schema.ts` whose aggregate object omits a table the same file declares.** An app that keeps `export const schema = { posts, users }` and hands `typeof schema` to drizzle had only one way to hear about a stale object: re-running a scaffolder over a table it had already added. An aggregate that went stale from a hand-added table, or from a release before the scaffolders wrote the key, was never mentioned.

The rule reads the object through the same detection the scaffolders use, so both agree on which object is the aggregate: every property a shorthand (or `name: name`) reference to a table the file declares, and exactly one such candidate. An app that keeps no aggregate contributes nothing.

The verdict is graded by how firmly the file identifies the object. Named `schema`, or read by a `typeof` (`export type AppSchema = typeof schema`) — the shape all three example apps use — and the `warn` counts against `guren check --ci` and `guren gate`. On a shape match alone it is advisory: an object of table shorthands may equally be a grouping the app keeps for itself, and a guess must not turn a correct schema's CI red. Plain `guren check` stays informational either way.

Two shapes are deliberately silent. A root schema reaching a module's tables through `export * from '../modules/<name>/db/schema'` has no identifier here to list, so those tables are never asked for; and an object holding a spread carries tables it does not name, which stops it being recognized as an aggregate at all.
