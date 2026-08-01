---
"@guren/cli": patch
---

Use one pluralization rule across scaffolding and `guren check`

`guren add resource Category` wrote `export const categories` into
`db/schema.ts` but generated `import { categorys } from '../../db/schema.js'`
in `app/Models/Category.ts` — the model did not compile. `guren check` then
looked for a table named `categorys` and warned that the table it had just
written was missing. Any entity ending in consonant + `y`, or in
`s`/`x`/`z`/`ch`/`sh`, hit this: `Category`, `Box`, `Match`, `Dish`.

The three sites derived the name independently. `make:feature` and the
`resource` blueprint carried byte-identical copies of one rule (`-ies` / `-es` /
`-s`); `make:model` and `check` used a separate `+ 's'`. They now share
`collectionName()` in `packages/cli/src/inflect.ts`, and the schema writer and
`check` share one `tableNameFor()` so the table name has a single derivation
rather than two that happen to agree.

`check`'s lookup was also wrong for every multi-word model regardless of
plural form — `UserProfile` resolved to `userprofiles` while the table is
`user_profiles`, so it warned on models that were fine.

`make:route` was a fourth rule again — it stripped one trailing `s` unless the
name ended in `ss`, so `make:route categories` scaffolded a `CategorieController`
that `make:feature Category` never generates. It now singularizes the same way.

Names that reach a database identifier tolerate already-plural input, so
`make:model News` keeps importing `news` rather than `newses`. Route paths,
page directories, and generated type names pluralize directly and are
unchanged — a lone trailing `s` cannot be read reliably (`News` and `Status`
are structurally identical), so only the names that have to agree across files
pay for that tolerance.

`guren check`'s model-schema result stays informational (a `warn`, and it does
not set the exit code). It still infers the table name rather than reading what
the model binds, so an app whose table does not follow the scaffolder's
convention can see this warning either way — the name in the message is now the
one the scaffolder would have written.
