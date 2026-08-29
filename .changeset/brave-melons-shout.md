---
"@guren/openapi": minor
---

Generated documents now carry the constraints a route's Zod schemas declare,
instead of only their types: `minLength`/`maxLength`/`pattern`/`format` on
strings, `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`
on numbers, and `minItems`/`maxItems` on arrays. A `z.string().min(1).max(120)`
body field used to document as a bare `{ "type": "string" }`.

A schema built with `z.int()`, `z.number().int()`, `z.int32()` or `z.uint32()`
now documents as `{ "type": "integer" }` rather than `{ "type": "number" }` —
the previous output advertised a contract accepting `3.14` that the route then
rejected. The same reasoning applies to a schema carrying two patterns or two
`multipleOf` values: the surplus is now conjoined under `allOf` instead of
dropped, so the document can no longer accept input the route refuses.

The schema walker itself moved to `@guren/core/internal/zod-json-schema`, so an
OpenAPI document and anything else derived from the same route cannot disagree
about a schema. The public API is unchanged.
