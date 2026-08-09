---
'@guren/orm': minor
---

Refuse, rather than silently drop, conditions the adapter cannot express

On an adapter implementing neither `findManyAdvanced` nor `countAdvanced`,
`QueryBuilder` flattened its conditions into a simple where-object and passed
`where: undefined` whenever that conversion failed — discarding every condition,
global scopes included, and returning the whole table. It now throws.

This is a **runtime behavior change beyond the global-scope fix it came from**,
which is why it is a minor rather than a patch. The conversion fails for more
than the exotic cases: every comparison operator (`>`, `<`, `>=`, `<=`, `!=`,
`like`), `not in`, `is not null`, and any `orWhere` group. So on such an adapter
`Post.where('views', '>', 100).get()` now throws where it previously returned
rows — rows that were unfiltered, and therefore wrong, but returned.

The shipped `DrizzleAdapter` implements both methods and never reaches this
path. Custom adapters and hand-rolled test doubles are what this affects; the
fix is to implement `findManyAdvanced`/`countAdvanced`.
