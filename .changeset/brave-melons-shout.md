---
"@guren/openapi": minor
---

Generated documents now carry the constraints a route's Zod schemas declare,
instead of only their types: `minLength`/`maxLength`/`pattern`/`format` on
strings, `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`
on numbers, and `minItems`/`maxItems` on arrays. A `z.string().min(1).max(120)`
body field used to document as a bare `{ "type": "string" }`.

The schema walker itself moved to `@guren/core/internal/zod-json-schema`, so an
OpenAPI document and anything else derived from the same route cannot disagree
about a schema. The public API is unchanged.
