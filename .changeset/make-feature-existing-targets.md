---
'@guren/cli': patch
---

`guren make:feature` and `guren add resource` check every file they would write before writing the first one. When any already exists, the command lists them all and writes nothing (`add resource` leaves `db/schema.ts` and `routes/web.ts` untouched too), instead of stopping at the first one with the files before it already written. `--force` still overwrites. With `--test`, an existing `tests/<Name>.test.ts` is now reported like any other file in the way rather than skipped without a word.
