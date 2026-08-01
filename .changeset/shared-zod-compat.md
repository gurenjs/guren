---
"@guren/core": patch
"@guren/openapi": patch
"@guren/cli": patch
---

refactor: share the Zod v3/v4 compatibility primitives between the two schema walkers

`@guren/cli`'s TypeScript-type renderer and `@guren/openapi`'s schema-object
renderer each carried their own copy of the knowledge needed to read a Zod
schema without caring which major produced it: type-name lookup, the `Zod`
prefix normalization, wrapper unwrapping, pipe-side selection, object-shape
reading, and enum/literal value extraction. Knowledge added to one never
reached the other — a Zod 4 array keeps its element in `_def.element` while
`_def.type` holds the string `'array'`, and reading them in the wrong order
silently dropped the element type. That single bug had to be found and fixed
twice, months apart, once per package.

Those primitives now live in `@guren/core/internal/zod-compat`, a deep-import
internal module in the same vein as `internal/deploy-build`. Both walkers read
from it, so a version quirk learned once is known in both places.

The type switches stay where they are — one produces TypeScript type strings,
the other OpenAPI schema objects, and they are not the same walk. `isOptional`
also stays split on purpose: the CLI reads only the side of a `.pipe()` it is
rendering, while the OpenAPI walker requires both sides to permit omission.

Two incidental hardenings come along for the ride. The CLI's inner-schema
lookup now skips non-object candidates instead of taking the first non-nullish
one, and a nested node with no readable type name renders as `unknown` rather
than throwing.
