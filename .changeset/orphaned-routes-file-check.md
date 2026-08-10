---
"@guren/cli": minor
---

`guren check` now reports a `routes/*.ts` file whose registrar nothing reachable from the app's entry registrar calls.

Such a file compiles, type-checks, and reads as wired from the inside — its only symptom is a 404 in production. That is the state `guren add admin|oauth|resource|auth` left behind in any app scaffolded from the blog blueprint, because the wiring step matched only a registrar whose parameter was literally named `router`. Fixing the scaffolders does nothing for the apps already in that state; this reports them, and names the import-and-call line to add. It also covers the files nothing wires automatically — `make:route` writes its routes file and leaves mounting to you.

Mounting spreads outward from the entry file (`routes/web.ts`, or `--routes`) and is tracked per exported name: a file counts as mounted once some already-mounted file uses a binding that traces back to one of its registrar exports. So a nested registrar, a barrel re-export, a namespace import, an `await import()`, and a registrar the entry only re-exports all count — while an import with no call, an import of some *other* export from the same file, and a registrar called only from a file that nothing calls in turn do not. A module's own `modules/<name>/routes.ts` is out of scope: `defineModule({ routes })` mounts it without going through the entry registrar. Content-activated — an app whose `routes/` holds nothing but the entry file contributes no results.

Two wirings it cannot see, both reported as unmounted: a chain that leaves `routes/` (`web.ts` → `app/routing.ts` → `routes/admin.ts`), and a registrar reached by anything less direct than importing its file.

Reported as a `warn`, like the console-command registration check, so plain `guren check` still exits zero. `guren check --ci` gates on non-advisory warns, so a project already using that flag will start failing on an unmounted routes file — which is the point, but it can surface on upgrade rather than on the commit that introduced it.

That gate is in the CI workflow both app templates scaffold, and `make:route` deliberately leaves mounting to you — so `make:route` now says so on the spot rather than letting the next push explain it.

Also fixes the entry file being *assumed* to be `routes/web.ts` when no `--routes` was given: `guren check` and `guren doctor` now share one candidate list, so the API-only scaffold (`routes/api.ts`, no `routes/web.ts`) is read against its real entry.
