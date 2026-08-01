---
"@guren/core": minor
"@guren/openapi": minor
"@guren/cli": minor
---

feat: the schema walkers read the zod 4 API only, and refuse zod 3 loudly

The TypeScript-type renderer (`guren codegen`, `guren context`) and the OpenAPI
generator previously walked both Zod majors. The two dialects disagree about
the meaning of `_def.type` — v3 stores a nested schema there, v4 the type
name — and that ambiguity is what produced the walker bugs that had to be
fixed twice. Since every Guren scaffold has always pinned zod 4, the walkers
now read the v4 layout exclusively.

A schema authored with the zod v3 API — whether from the old `zod@3` package
or the `zod/v3` subpath that zod 4 itself ships — is detected up front (only
v3 sets `_def.typeName`) and refused with an explicit message instead of being
rendered wrong or silently dropped: the CLI warns once per process, the
OpenAPI document records a warning naming the schema's location. The message
lives in `@guren/core/internal/zod-compat` as `ZOD3_UNSUPPORTED_MESSAGE`, so
the two surfaces cannot drift apart.

Dropping the v3 dialect also deletes code that was unreachable under v4:
the `pipeline`, `discriminatedunion`, and `nativeenum` case labels (v4 names
them `pipe`, `union`, and `enum`), the `effects` and `branded` wrapper names
(v4 has no such nodes — `.brand()` adds nothing at runtime), and the
function-shaped `_def.shape` read.

Two behavior improvements ride along. `z.nativeEnum` now documents numeric
enums through the shared `enum` path: reverse mappings of a numeric
TypeScript enum (`{ A: 0, '0': 'A' }`) are filtered out — previously both
directions could leak into the OpenAPI `enum` list — and a mixed
string/number enum documents as `type: ['string', 'number']` rather than
`number`. The `zod/v3` subpath was never used by any Guren template, example,
or generated app.
