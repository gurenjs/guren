---
'@guren/cli': patch
---

fix(cli): pass the dialect drizzle-kit requires when `make:migration` overrides the config

`make:migration` never stated `--dialect`, which drizzle-kit requires and will
not infer, so two paths could not generate anything on any app:

- The documented override flow. `--schema`/`--out` suppress `--config`
  entirely, so `guren make:migration --schema ./custom/schema.ts --out
  ./custom/migrations` failed with `dialect: undefined` even against a config
  that declared one.
- The no-config fallback, whose `db/schema.ts` / `db/migrations` defaults were
  therefore unreachable in practice.

Restoring `--config` alongside the overrides is not available: drizzle-kit
refuses the two together ("You can't use both --config and other cli options
for generate command"). So the overrides now carry everything the config would
have supplied — `dialect`, `driver`, and any un-overridden `schema`/`out`.

As a result, overriding only `--schema` no longer relocates the migrations to
the default folder; the config's `out` is kept, so one app's history stays in
one directory.

A config field that `generate` exposes no flag for cannot be restated this way
— `breakpoints: false` is the one such case, since `--breakpoints` has no
negation. The command now names any such field in a warning instead of letting
the generated SQL differ from what the config asked for.

Apps with no drizzle config can now state the dialect themselves with a new
`--dialect` flag. When nothing declares one, the command stops before spawning
drizzle-kit and names the missing field and the fix, rather than surfacing
`dialect: undefined` against flags the user never typed. A config declaring
`schema` as a list is likewise refused, because `--schema` takes one value and
a repeated flag silently keeps only the last.
