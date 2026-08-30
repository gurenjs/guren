---
"@guren/server": patch
"@guren/testing": minor
---

Route contracts and `validateBody()` accept non-object request bodies.

A body that parsed to anything other than a plain object was replaced with `{}` before validation ever saw it, so a route declaring `body: z.array(z.number())` or `body: z.string()` could not receive its payload — every request 422'd against an empty object, whatever the client sent. This affected every HTTP caller, not one dispatch path.

The parse step now has two shapes, and the caller picks by what it does with the result:

- `parseRequestBody()` (internal) returns the parsed value as sent — an array stays an array, a string stays a string — and is what feeds a route contract's `body`, `Controller.validateBody()` / `validateBodySafe()`, and the `validateRequest()` / `validateRequestWith()` middleware. The schema decides the shape.
- `parseRequestPayload()` (unchanged, still exported) is the record view, for callers that read the body field by field: `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization. A non-object body reads as `{}` there, exactly as before, because there is no field to read on one.

Two behaviors are deliberately preserved. A malformed or empty JSON body still parses to `{}`, so an all-optional object schema keeps passing on an empty POST — the cost is that a non-object schema sees that `{}` and returns 422 rather than receiving nothing. And form submissions still normalize to a record, since they have no non-object shape to keep. (A form body that fails to parse at all is unchanged and still separate: `Controller` catches it and validates `{}`, while a route contract or `validateRequest()` lets it surface as a 500.)

`@guren/testing`'s controller mock gains the same split. Its `parseRequestPayload` now narrows exactly as the runtime's does, and the mock `Controller` gains `getRawBody()`, which validation reads instead. Previously the mock narrowed nowhere, so a mocked controller and a real one disagreed on every non-object body — a test written against the mock could pass on code the runtime would 422. Two divergences on the same path close with it: a JSON body of literal `null` is no longer coalesced to `{}` before validation, and a body the parser rejects falls back to `{}` as the real `Controller` does rather than throwing out of `validateBody()`.

The change to the mock is additive — `getRawBody()` is the only new member on the exported class type, and `parsedBody` keeps both its declared shape and its role as the record-view memo.
