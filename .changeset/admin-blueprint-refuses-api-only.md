---
'@guren/cli': patch
---

Refuse `add admin` on an API-only app instead of scaffolding an unusable dashboard

`guren add admin` scaffolds an Inertia dashboard, and on an app created from the
`api` blueprint every file it wrote was unusable. The controller imports
`@/.guren/pages.gen` and returns an Inertia response, so it did not typecheck
against a `@guren/inertia-client` the API starter never installs — and running
page codegen then added an import of that absent package. The route wiring
targets `routes/web.ts`, which the API starter does not have (it registers
`registerApiRoutes` from `routes/api.ts`), so `routes/admin.ts` was written but
mounted by nothing and `GET /admin` returned 404. The CLI then printed that
`/admin` requires a signed-in user and redirects to `/login`, which is not what
the resulting app did.

The blueprint now checks before its first write and fails with a message naming
what it looked at, leaving nothing behind. Rejecting rather than emitting a JSON
variant is deliberate: an admin endpoint worth generating needs a guard, and the
auth stack that guard points at (`guren add auth`) is itself Inertia-shaped, so
the API variant would either reference sign-in pages the CLI cannot install or
be an unguarded stub.

Detection requires positive evidence of the API-only shape — a readable
`package.json` that does not declare `@guren/inertia-client`, **and** no
`routes/web.ts` or `routes/web.js`. Either signal alone can be true of a working
fullstack app (deps hoisted to a workspace root; a differently named entry file,
which the route wiring already reports), and for a refusal the expensive mistake
is blocking a command that would have worked. Every "cannot tell" — including a
`package.json` that exists but cannot be read — permits the scaffold.

The shared dependency probe behind it (`appDependsOn`) also replaces three
hand-rolled copies of the same `package.json` read, in `guren plugin`,
`guren make:test`, and the i18n type codegen. The codegen copy swallowed read
errors and the new one has to as well: its augmentation is optional output, so
an unreadable manifest must leave the translation keys as plain strings rather
than abort the run.

The `--public` next step is also reworded to describe what `routes/admin.ts`
contains rather than how the running app behaves, so it can no longer contradict
the wiring step when that step reports it could not reach a registrar.
