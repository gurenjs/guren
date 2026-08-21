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
files were covered — but its list omitted the `drizzle.config.ts` it ships, so
that went unchecked there for a different reason. It now covers that too.

`tests/` is covered in the default template but deliberately not yet in
api-only: the test file api-only ships passes `providers: [DatabaseProvider]`
to `TestApp.create()`, and `@guren/testing` types that parameter as
`new (...args: unknown[]) => ProviderLike`, which no real `ServiceProvider`
subclass satisfies. That is a defect in the testing package's published type,
not in the template, and widening the include here before it is fixed would
only make the starter smokes red.
