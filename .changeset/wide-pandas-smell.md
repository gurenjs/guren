---
'create-guren-app': patch
---

Widen both starter templates' TypeScript `include` so they cover the files they
always meant to.

In the default template `".guren"` matched nothing: TypeScript expands a bare
directory name to a wildcard, and its wildcard matcher skips dot-prefixed path
segments. Generated files that something imports still arrived through the
import graph, which is what hid the dead entry — the ones nothing imports
(`data.gen.ts`, `channels.gen.ts`, `translations.gen.ts`) were never checked at
all. `config/`, `bin/`, `tests/`, `drizzle.config.ts`, and `vite.config.ts`
were outside the list too.

The api-only template already used the explicit-glob form, so its generated
files were covered — but its list omitted the `tests/` and `drizzle.config.ts`
it ships, so those went unchecked there for a different reason. Both templates
now cover everything they scaffold, and `bun run typecheck` in a scaffolded app
reads all of it.
