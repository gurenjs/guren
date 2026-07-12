---
"@guren/server": minor
"@guren/core": patch
"@guren/orm": patch
"@guren/cli": patch
"@guren/testing": patch
"@guren/openapi": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

Accept Hono middleware as a terminal route handler:

- **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
- **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.
