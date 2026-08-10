---
'@guren/cli': patch
---

Refuse `add resource` before it patches anything, instead of failing halfway through

`guren add resource` edits two files the app owns: it appends a table to
`db/schema.ts` and registers the CRUD routes in `routes/web.ts`. Refusing the
API-only app took the common case out of that path, and named what it left
behind: an app that declares `@guren/inertia-client`, or that has no manifest to
read at all, is permitted on purpose — a shape check has to answer "cannot tell"
with "proceed" — and still walked into an unguarded `readFile`. That is what this
finishes.

Both reads were unguarded, so those apps failed with a raw `ENOENT: no such file
or directory` and a seven-frame `node:fs` stack. Missing `db/schema.ts` failed
first and wrote nothing; missing `routes/web.ts` was the damaging one, because
that read runs *after* the schema patch — by then eight scaffolded files were on
disk *and* the app's own `db/schema.ts` carried a table for routes that were
never registered. Deleting the scaffold does not undo that.

The blueprint now settles both patches before its first write: the schema file
must exist, the routes file must exist, and — unless the routes are already
registered — the routes file must expose a registrar to patch. Each refusal names
the file it wanted and writes nothing. The last of the three replaces a throw
that already had this message but only reached it after the schema patch and the
scaffold.

The order of the two checks matters and is deliberate: the shape refusal runs
first, so an app it recognizes hears about being API-only rather than about a
missing file.

Scoped to those three questions on purpose. This is not a promise that the
patches will succeed: a target that exists but cannot be read or written still
fails in the writer, exactly as before. What it removes is the failure the
command could see coming.

Reordering the two patches was the other option and does not work: it only
chooses which of the app's files is left half-edited. Routes-first would patch
`routes/web.ts` with a controller and validator import for a table that does not
exist, which is the worse of the two, since that is the edit that stops the app
compiling.

`add admin` still warns rather than throwing in the comparable case, and that
asymmetry stays. Its output is self-contained — a controller, a page, and its own
`routes/admin.ts` — so a warning leaves a complete scaffold the developer can
wire by hand. `add resource` has no such fallback: its controller and validator
imports are dead without registration, and its patches target files it did not
create.
