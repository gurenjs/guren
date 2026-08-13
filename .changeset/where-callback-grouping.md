---
"@guren/orm": minor
"create-guren-app": patch
---

`where(callback)` and `orWhere(callback)` compose parenthesized condition groups, Laravel's `where(fn ($q) => ...)`.

Until now `orWhere()` always pushed a top-level OR, so "(title LIKE ? OR excerpt LIKE ?) AND published = true" was inexpressible from application code — any AND filter next to an OR keyword chain (a published flag, tenancy, soft deletes) was silently OR'd away. The callback form collects conditions on a nested builder and folds them into a single group AND-ed with the rest of the query (`orWhere(callback)` ORs the whole group instead). Sequential semantics inside the callback match the top level: `.where(a).where(b).orWhere(c)` reads `(a AND b) OR c`, and callbacks nest. Groups render through the existing Drizzle condition tree, verified against the real sqlite driver alongside SoftDeletes and global scopes.

The blog starter's `posts.search` action now groups its keyword OR chain this way, so filters added after it apply to every match.
