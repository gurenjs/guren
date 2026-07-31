---
"@guren/orm": minor
"@guren/cli": minor
---

Let `defineModel()` reshape the inferred create payload without a cast.

`defineModel(table)` infers `createType` from the table, which requires every
non-defaulted column — the wrong shape for a model that fills a column in
itself. `AuthenticatableModel` is the standing example: it hashes a plain
`password` into `passwordHash`, so callers pass the former and not the latter,
and until now the only way to say so was to skip `defineModel()` entirely and
redeclare the type markers by hand.

Two type-level options replace that:

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  static guarded = ['id', 'passwordHash', 'rememberToken']
  static override hidden = ['passwordHash', 'rememberToken']
}
```

`optionalOnCreate` makes columns optional — they keep their type, callers just
need not supply them. `requireOnCreate` goes the other way, accepting both
table columns (Drizzle marks defaulted ones optional) and named fields
contributed by `base`. Both are checked against the real keys, so a typo fails
to compile, and neither has a runtime effect. Neither closes the payload
either: a create type always admits unknown keys as `unknown`, so
`fillable`/`guarded` remain what reject an unwanted field at runtime.

`make:auth` now generates this shape — with `requireOnCreate` only when
password sign-up is the sole way in, since OAuth accounts are created without
one — and guards `passwordHash` against mass assignment, which the scaffolded
model previously left on its default.

The `createType` option is deprecated in favour of these: it needs a value to
infer from, which is exactly the cast this removes. It still works, and
`defineModel<TTable, TBase, TCreate>()` still means what it did — the two new
type parameters go after `TCreate`, not before it.

Also fixes `guren audit`: its sensitive-column check resolved a model's table
only from `static table = users`, so it silently skipped any model written as
`defineModel(users, …)` — including every model this release migrates.
