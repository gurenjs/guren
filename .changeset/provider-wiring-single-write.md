---
'@guren/cli': patch
---

Wire providers into the app entry through one registrar that writes once

Three implementations of "register a provider in the app entry and report the
outcome" coexisted — the blueprints' `installProvider`, `make:auth`'s
`wireProvider`, and two inline copies inside `make:auth` for the framework's own
mail and OAuth service providers. They are now one shared helper, which closes
the gaps between them.

`guren add cache` — and every other infrastructure blueprint, and `guren plugin`
— probed only `src/app.ts`. An app that keeps its entry at the root (`app.ts`,
which `guren add auth` and `guren make:module` both already found) was reported
as having no app file at all. The entry now comes from one shared candidate
list, and the generated import is relative to whichever entry was found, so a
root `app.ts` gets `./app/Providers/CacheProvider.js` rather than a path that
climbs out of the project.

`guren add auth` still added each provider's import *before* registering it, as
did `guren plugin`. On an app whose `providers: [ ... ]` array cannot be located
— a hand-edited entry, or one that never had the array — the run reported a
failure having already written an import nothing references, which stops the app
compiling under `noUnusedLocals`. `guren plugin` was the worst of the two: it
throws rather than warning, so it left the orphan import behind and refused to
finish.

Registering before importing, as the blueprints already did, is not the whole
fix. The two patches each read and rewrite the entry independently, so whichever
runs second can fail on its own — a permissions change, a full disk, an
interrupt — and the state that leaves, "registered but not imported", is worse
than the one being avoided: an unresolved identifier throws at runtime rather
than merely failing a lint. Both edits are now composed in memory, through a
pure `insertProvider` beside the existing `insertImport`, and applied in a
single write. An entry that cannot take one half receives neither. This is the
shape `addRouteRegistrarCall` already used for the same reason, and what
`insertImport`'s own documentation was written for.

`guren make:module` had the same import-first hazard against its
`modules: [ ... ]` patch, and is fixed the same way.

Reporting stays per command, because the three callers genuinely differ: the
blueprints warn and name what to register by hand, `guren add auth` narrates
each step, and `guren plugin` throws and collects structured messages rather
than touching the console. Only the entry resolution and the patch primitive are
shared. One nicety falls out of the consolidation — inside a single
`guren add auth` run, the framework's own service providers now report the way
the scaffolded ones always did, instead of staying silent when they were already
registered.
