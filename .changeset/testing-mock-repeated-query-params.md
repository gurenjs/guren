---
"@guren/testing": patch
---

Fix the controller mock reading repeated query parameters differently from the runtime.

The mock's `validateQuery()` / `validateQuerySafe()` validated against `this.ctx.req.query()`, which is one value per key. The runtime validates against `flattenRequestQueries`, which reads `ctx.req.queries()` and returns `values.length === 1 ? values[0] : values` — so a repeated key arrives as an **array** and a single occurrence as a string. For `?tag=a&tag=b`, a `z.array(...)` schema saw `['a', 'b']` in production and `'b'` in the mock, letting a controller test pass on behavior production does not have (or fail on behavior it does).

Both surfaces now flatten through one shared rule that mirrors `flattenRequestQueries` exactly. `queries()` is optional on `ControllerContext`, so a context that lacks one re-derives the same grouping from the required `req.url`; the one thing it must not fall back to is `query()`, which is single-valued by construction and is the divergence being closed.

The mock's no-arg `ctx.req.query()` was built with `Object.fromEntries(searchParams.entries())`, keeping the **last** occurrence of a repeated key, while Hono's keeps the **first** (`?tag=a&tag=b` reads back as `a`). That second divergence is fixed too.

`packages/testing/tests/controller.test.ts` pins the parity by running the same URL through the mock and through a real `Application.fetch()` controller, covering a repeated key and a single-occurrence key in one comparison, so the two cannot drift apart again.
