---
"@guren/cli": patch
"@guren/testing": patch
---

Declare the optional siblings these packages import so their types stop being `any`.

`@guren/cli` reaches `@guren/openapi`, and `@guren/testing` reaches `@guren/core`,
through a dynamic `import()` only. Neither was declared, so under each package's
`tsconfig.build.json` (which clears `paths` so the declaration emitter cannot
write stray `.d.ts` files beside a sibling's source) the specifier was
unresolvable, the import was silenced with `@ts-ignore`, and everything inferred
from it degraded to `any`.

Both are now declared as **optional peer dependencies**, which resolves them to
the sibling's real declarations. Neither npm nor bun installs an optional peer
automatically, so nothing changes about what an app installs — but an app that
does have the sibling now gets it type-checked, and the mismatch this surfaced
in `@guren/testing` (its structural `Application` constructor type disagreed
with the real one about `providers`) is fixed rather than hidden.
