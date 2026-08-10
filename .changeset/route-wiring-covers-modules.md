---
'@guren/cli': patch
---

Extend `guren check`'s route registrar wiring to application modules

The wiring check flagged a `routes/*.ts` file whose registrar nothing reachable
from the app's entry registrar calls — but only under the project's own
`routes/`. `make:route Foo --module billing` writes to
`modules/billing/routes/Foo.ts`, where the file that has to mount it is not the
app's entry at all: a module mounts routes through `defineModule({ routes })`,
which names exactly one registrar, `modules/billing/routes.ts`. A file beside
it was mounted by nothing, and no check reported the gap.

The check now asks the same question once per scope: the project's `routes/`
against the app's entry, and each module's `routes/` against the registrar its
own `defineModule({ routes })` names — resolved from the descriptor, the same
link the runtime follows, rather than guessed from a conventional filename.
That resolution is what keeps both directions honest: a descriptor with no
`routes` property mounts nothing however well-wired `routes.ts` is internally
(reported as one warning at the descriptor, since that is where the fix is),
and a descriptor naming `routes/index.ts` mounts that file even when a stale
`routes.ts` sits beside it. A `routes` value the check cannot trace to a file
skips the module rather than judging it against the wrong entry — this check
misses orphans, it does not invent them. Scopes share no state, so one
module's registrar cannot credit another module's identically named
`registerRoutes`, and mounting a module's file from `routes/web.ts` does not
count — that import crosses the module boundary without making the module
mount anything. The `--changed` gate wakes for `modules/<name>/routes` and
`modules/<name>/index.ts` edits too — deleting `routes:` from `defineModule()`
severs every module route while changing only the descriptor. Modules without
a `routes/` directory — the shape `make:module` scaffolds — contribute
nothing, as before.

`make:route`'s next-step hint now says `guren check` reports the gap, which
used to be true only at the project root.
