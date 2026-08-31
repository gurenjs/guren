---
"@guren/server": patch
---

Fix `__proto__` query parameters being dropped before reaching a validation schema.

`flattenRequestQueries()` — which backs `Controller.validateQuery()` / `validateQuerySafe()` and every route contract's `query` schema — built its result by assigning into an object literal. Query keys are attacker-controlled, and `flat['__proto__'] = …` hits `Object.prototype`'s inherited setter rather than defining a field, so a `__proto__` key was lost in one of two ways depending on how often it was repeated:

- `?__proto__=one` assigned a **string**, which is a silent no-op. The field never reached the schema, so a schema requiring it failed and one merely reading it saw nothing.
- `?__proto__=one&__proto__=two` assigned the **array**, which is not a no-op: it replaced the returned record's own prototype, handing the schema an object whose inheritance came from the request.

Hono groups query parameters into a null-prototype object, so the key arrives intact and only this last step could lose it. The record is now materialized with `Object.fromEntries`, which defines own properties — the same rule, for the same reason, that the form branch of `parseRequestBody()` already follows.

Covered directly in `packages/server/tests/http/request.test.ts`, and through `validateQuery()` on both a real `Application.fetch()` and `@guren/testing`'s controller mock.
