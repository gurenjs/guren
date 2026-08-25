---
"@guren/cli": minor
"create-guren-app": minor
---

Stop casting record columns in scaffolded resources

`make:feature`, `guren add resource` and `make:resource` wrote
`id: this.resource.id as number` and `title: this.resource.title as string`
into every generated resource. The record is `typeof table.$inferSelect`, so
each column is already typed and the casts only hid mistakes: `as string` on a
column that is later made nullable swallows the `null` while the resource keeps
compiling, and `as number` hard-codes a primary key an app with a UUID does not
have. The key's type is now read off the record (`id: PostRecord['id']`).

`json` columns keep their assertion, in every dialect: `jsonb()`, `json()` and
`text({ mode: 'json' })` all infer `unknown` unless the schema pins a `$type`.

Generated resources also declare their payload as the `Resource` class's second
type argument instead of overriding `toJSON()` to cast. That argument arrives in
the `@guren/core` released alongside this one, so upgrade `@guren/core` and
`@guren/cli` together — `bunx guren upgrade` does that, and a lone CLI upgrade
would scaffold a resource the installed core cannot type.
