---
'create-guren-app': minor
'@guren/cli': patch
---

Reload backend changes without restarting the dev server

`dev:server` now runs `bun --hot bin/serve.ts` in both templates, so edits to
controllers, routes, and models take effect on the next request instead of
requiring a manual restart. In the default frontend template, adding a route
re-runs codegen and reloads once more, then settles.

Keep `@guren/cli` current before adding the flag to an existing project. The
reload only settles because codegen leaves `.guren/*.gen.ts` untouched when the
output is unchanged; older versions rewrote them on every run, and since your
controllers import those files, each rewrite triggers the next reload.

State held in the process does not survive a reload: the memory-backed session
and cache stores are rebuilt empty, and module-level variables are
reinitialized. External stores — Redis, the database — are unaffected.

`guren doctor` now counts `dev:server` among the scripts an app is expected to
have, so its autofix no longer adds a `dev` script that calls a missing one.
