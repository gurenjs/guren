---
"@guren/server": patch
"@guren/testing": minor
---

Route contracts and `validateBody()` accept non-object request bodies.

A body that parsed to anything other than a plain object was replaced with `{}` before validation ever saw it, so a route declaring `body: z.array(z.number())` or `body: z.string()` could not receive its payload — every request 422'd against an empty object, whatever the client sent. This affected every HTTP caller, not one dispatch path.

The parse step now has two shapes, and the caller picks by what it does with the result:

- `parseRequestBody()` (internal) returns the parsed value as sent — an array stays an array, a string stays a string — and is what feeds a route contract's `body`, `Controller.validateBody()` / `validateBodySafe()`, and the `validateRequest()` / `validateRequestWith()` middleware. The schema decides the shape.
- `parseRequestPayload()` (unchanged, still exported) is the record view, for callers that read the body field by field: `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization. A non-object body reads as `{}` there, exactly as before, because there is no field to read on one.

Two behaviors are deliberately preserved. A malformed or empty body still parses to `{}`, so an all-optional object schema keeps passing on an empty POST — the cost is that a non-object schema sees that `{}` and returns 422 rather than receiving nothing. And form submissions still normalize to a record, since they have no non-object shape to keep.

`@guren/testing`'s controller mock gains the same split, on both halves: its module-level `parseRequestPayload` now narrows exactly as the runtime's does, a new `parseRequestBody` returns the body as sent, and the mock `Controller` routes validation through the raw one. Previously the mock narrowed nowhere, so a mocked controller and a real one disagreed on every non-object body — and a test written against the mock could pass on code the runtime would 422.

That is a minor rather than a patch for `@guren/testing` because the mock `Controller`'s `parsedBody` field — public only to satisfy TS4094 on the factory's exported class type — changes from `Record<string, unknown>` to a `{ value: unknown }` box, so that a body of `null`, `''`, `0` or `false` is memoized rather than re-read from a consumed stream.
