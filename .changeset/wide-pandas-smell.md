---
'create-guren-app': patch
---

Widen the starter template's TypeScript `include` so it covers the files it
always meant to.

`".guren"` matched nothing: TypeScript expands a bare directory name to a
wildcard, and its wildcard matcher skips dot-prefixed path segments. Generated
files that something imports still arrived through the import graph, which is
what hid the dead entry — the ones nothing imports (`data.gen.ts`,
`channels.gen.ts`, `translations.gen.ts`) were never checked at all. `config/`,
`bin/`, `tests/`, `drizzle.config.ts`, and `vite.config.ts` were outside the
list too.

`bun run typecheck` in a scaffolded app now reads all of them. The api-only
template already used the explicit-glob form; this brings the default template
(which blog and worker also build on) into line with it.
