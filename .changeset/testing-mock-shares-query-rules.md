---
"@guren/server": minor
"@guren/testing": minor
---

Stop `@guren/testing`'s controller mock keeping its own copy of the query-reading rules.

Follows the split the request-body change made: the rule is shared, the adapter stays local. Two restatements of runtime behavior are gone from `packages/testing/src/controller.ts`.

`flattenContextQueries()` was a line-for-line copy of the runtime's `flattenRequestQueries()` — same loop, same `values.length === 1 ? values[0] : values`. It now calls that function, reached through `@guren/server/internal/request`. To make it reachable, `flattenRequestQueries()` takes a structural parameter naming the one member it reads (`RequestQueryContext`) instead of a whole Hono `Context`. Narrowing a parameter accepts strictly more callers, so every existing caller passes a real `Context` unchanged. It is spelled as the call shape rather than as `Pick<HonoRequest, 'queries'>`, because `HonoRequest.queries` is overloaded and a `Pick` keeps both signatures, which the plain `() => Record<string, string[]>` on `ControllerContext` cannot satisfy.

`groupSearchParams()` restated `HonoRequest.queries()`; both of its call sites now use `HonoRequest` itself, and it is deleted.

**`queries?()` stays optional on `ControllerContext`, and an override supplied there is still honored.** The published type is consumed by application test suites, and the fallback for a context lacking one is load bearing — it re-derives the grouping from the required `req.url` and must never fall back to `query()`, which is single-valued by construction. So the adapter keeps that branch: a context that carries `queries()` hands it to the shared rule, one that does not is re-derived through a `HonoRequest`. Building the `HonoRequest` unconditionally from `req.url` would have read past the override silently.

The adapter invokes an override as a *method* on `ctx.req` rather than handing the shared rule a bare function reference. `queries?: () => Record<string, string[]>` is satisfied by a method as readily as by an arrow, so an override may read `this.url`; rebinding it onto a fresh object would silently give it the wrong receiver.

This also fixes a real divergence, not just duplication. The mock's no-arg `ctx.req.query()` built its record by assignment (`first[name] ??= value`), so a `__proto__` query key hit `Object.prototype`'s inherited setter and vanished: `?__proto__=x` read as absent in a controller test and as a value in production. Hono builds a null-prototype object, which has no setter to hit, and `query()` now delegates to it. This is the same footgun the mock's form-body collection was fixed for earlier.

Sharing the rule exposed a second `__proto__` bug, this one in the runtime itself and reaching every `validateQuery()` in production. `flattenRequestQueries()` built its record by assignment, so an attacker-controlled `?__proto__=` key was lost in one of two ways: a single occurrence set `__proto__` to a string, which is a silent no-op, so the field never reached the schema; a repeated one assigned the *array*, which replaced the returned record's prototype. Hono hands the key over intact in a null-prototype object — only this last step lost it. The record is now materialized with `Object.fromEntries`, the same rule the form branch of `parseRequestBody()` already follows for the same reason.

One deliberate behavior change to note: `createControllerContext()`'s no-arg `query()` and `queries()` now return **null-prototype** objects, because that is what Hono returns and they now delegate to it. `Record<string, string[]>` promises no prototype, and a real controller's `ctx.req` has always behaved this way, so this brings the mock into line with production rather than away from it — but a test calling `ctx.req.queries().hasOwnProperty(...)` on the result would need `Object.hasOwn(...)` instead, exactly as it would against a live request.

`packages/testing/tests/controller.test.ts` keeps pinning the parity by running one URL through the mock and through a real `Application.fetch()`, covering the repeated key, the single occurrence, and the no-`queries()` fallback, with new cases for the `__proto__` key on the raw surfaces and through `validateQuery()`. `packages/server/tests/http/request.test.ts` covers the flattener's single- and repeated-`__proto__` handling directly.
