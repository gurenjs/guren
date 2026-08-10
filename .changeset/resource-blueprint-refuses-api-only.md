---
'@guren/cli': patch
---

Refuse `add resource` on an API-only app instead of half-scaffolding and then crashing

`guren add resource` is Inertia-shaped end to end, and on an app created from the
`api` blueprint it wrote eight unusable files before failing. The four page
components under `resources/js/pages/<collection>/` are React, the controller
returns Inertia responses and imports `@/.guren/pages.gen`, and none of it
typechecks against a `@guren/inertia-client` the API starter never installs.

The failure then arrived from the wrong place. `updateResourceRoutes` opens
`routes/web.ts` unconditionally, and the API starter registers
`registerApiRoutes` from `routes/api.ts` instead, so the run ended in a raw
`ENOENT: no such file or directory, open '.../routes/web.ts'` with a stack trace
through `node:fs` — not a message about the app being the wrong shape for the
command. Everything already written stayed on disk.

That included one file the user wrote themselves: `updateResourceSchema` runs
before the route wiring, so a `posts` table was appended to `db/schema.ts`.
Deleting a scaffold does not undo that, which is what makes this worse than the
same bug in `add admin` — there, every casualty was a new file.

The blueprint now goes through `assertNotApiOnly()`, the same refusal the `admin`
and `auth` scaffolds use, and fails with a message naming the Inertia-shaped
output and the two signals it read, leaving nothing behind. The check runs after
the name and `--fields` parsing, which are pure, so a bad invocation on an
API-only app is still reported as a bad invocation rather than masked by the
app's shape.

An app that does declare the client but has no `routes/web.ts` is still
permitted, and still fails inside `updateResourceRoutes` — as does any app whose
routes file has no registrar, which has always thrown after the schema write.
That residue is untouched here and pinned by a test so the two failures cannot
be mistaken for each other.
