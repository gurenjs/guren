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

Input that is already plural is now singularized before pluralizing, so
`make:feature Posts` produces the `posts` collection rather than `postses`, and
`make:model News` keeps importing `news`. The collection also names the route
path and page directory, so re-running `make:feature Posts` after upgrading
scaffolds `/posts` and `resources/js/pages/posts/` where it previously produced
`/postses`. `guren add resource` is unaffected — it already singularized its
input.
