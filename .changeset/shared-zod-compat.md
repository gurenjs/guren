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

The set of type names that carry exactly one nested schema moves too, as
`SINGLE_CHILD_WRAPPERS` plus the two partitions each walker needs. The walkers
had looked like they disagreed here — one held a five-name set, the other a
twelve-name one — but the CLI simply handled the other seven as explicit
`switch` cases. They differ in how they partition the vocabulary, not in what
is in it, so the membership is now stated once.

The type switches themselves stay where they are: one produces TypeScript type
strings, the other OpenAPI schema objects. Their leaf vocabularies have
legitimately diverged (the CLI renders `void`/`any`/`never`, which OpenAPI
cannot express), and that is a rendering decision rather than version
knowledge.

Both `isOptional`s also stay with their callers, but not because each is right
for its own purpose — the CLI reads one side of a `.pipe()` and the OpenAPI
walker requires both, and each can be fooled by a pipeline the other handles.
Deciding omissibility correctly means simulating a parse, which is a separate
piece of work; the two approximations are now labelled as such where they live.

Three incidental hardenings come along for the ride. The CLI's inner-schema
lookup now skips non-object candidates instead of taking the first non-nullish
one; a nested node with no readable type name renders as `unknown` rather than
throwing; and two degenerate schemas that used to emit invalid TypeScript now
render correctly — an empty `z.enum([])` as `never` instead of an empty string,
and `z.literal(undefined)` as `undefined` rather than being dropped by
`JSON.stringify`.
