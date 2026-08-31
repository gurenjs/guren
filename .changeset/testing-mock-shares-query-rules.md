---
"@guren/server": minor
"@guren/testing": minor
---

Stop `@guren/testing`'s controller mock keeping its own copy of the query-reading rules.

Follows the split the request-body change made: the rule is shared, the adapter stays local. Two restatements of runtime behavior are gone from `packages/testing/src/controller.ts`.

`flattenContextQueries()` was a line-for-line copy of the runtime's `flattenRequestQueries()` — same loop, same `values.length === 1 ? values[0] : values`. It now calls that function, reached through `@guren/server/internal/request`. To make it reachable, `flattenRequestQueries()` takes a structural parameter naming the one member it reads (`RequestQueryContext`) instead of a whole Hono `Context`. Narrowing a parameter accepts strictly more callers, so every existing caller passes a real `Context` unchanged. It is spelled as the call shape rather than as `Pick<HonoRequest, 'queries'>`, because `HonoRequest.queries` is overloaded and a `Pick` keeps both signatures, which the plain `() => Record<string, string[]>` on `ControllerContext` cannot satisfy.

`groupSearchParams()` restated `HonoRequest.queries()`; both of its call sites now use `HonoRequest` itself, and it is deleted.

**`queries?()` stays optional on `ControllerContext`, and an override supplied there is still honored.** The published type is consumed by application test suites, and the fallback for a context lacking one is load bearing — it re-derives the grouping from the required `req.url` and must never fall back to `query()`, which is single-valued by construction. So the adapter keeps that branch: a context that carries `queries()` hands it to the shared rule, one that does not is re-derived through a `HonoRequest`. Building the `HonoRequest` unconditionally from `req.url` would have read past the override silently.

This also fixes a real divergence, not just duplication. The mock's no-arg `ctx.req.query()` built its record by assignment (`first[name] ??= value`), so a `__proto__` query key hit `Object.prototype`'s inherited setter and vanished: `?__proto__=x` read as absent in a controller test and as a value in production. Hono builds a null-prototype object, which has no setter to hit, and `query()` now delegates to it. This is the same footgun the mock's form-body collection was fixed for earlier.

`packages/testing/tests/controller.test.ts` keeps pinning the parity by running one URL through the mock and through a real `Application.fetch()`, covering the repeated key, the single occurrence, and the no-`queries()` fallback, with a new case for the `__proto__` key.
