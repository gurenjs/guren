---
'@guren/server': minor
'@guren/core': minor
'@guren/testing': minor
'@guren/cli': minor
'@guren/openapi': minor
---

First-class support for the HTTP QUERY method (RFC 10008)

QUERY is safe and idempotent like GET but carries a request body like POST — the right verb for search and filter endpoints whose criteria don't fit in a URL.

- `router.query(path, options, handler)` registers QUERY routes with the same overloads as the other verbs, on the router and inside `middleware(...)` group builders (which also gain the generic `on()` for arbitrary methods).

```ts
router.query('/posts/search', {
  name: 'posts.search',
  body: z.object({ keywords: z.array(z.string()) }),
}, [PostsController, 'search'])
```

- `TestApp.query(path, body?)` drives QUERY routes in tests.
- Codegen picks QUERY routes up automatically; the generated API client sends them with a body (`client.request('posts.search', { body })`).
- CSRF protection deliberately skips QUERY by default: it is a safe method, and browsers cannot send it without a CORS preflight. Keep QUERY handlers read-only, or opt into protection via the middleware's `methods` option — the generated client keeps sending the XSRF header on same-origin browser requests, so that opt-in works there (cross-origin clients supply their own header, as with every method).
- `guren audit` checks body validation on QUERY routes without demanding auth middleware on them, matching GET.
- The OpenAPI generator now allowlists the methods OpenAPI 3.1 can express and skips others (QUERY included) with a warning — previously a QUERY route would silently produce an invalid document. Mounted docs surface those warnings once via `console.warn`.

Also fixed: `createCorsMiddleware` used to hand Hono an explicit `allowMethods: undefined`, which erased Hono's default and made every preflight answer without an `Access-Control-Allow-Methods` header. Guren now owns the default list (GET, HEAD, PUT, POST, DELETE, PATCH, QUERY).

Deployment note: Guren's fetch-based adapters (Bun, the Cloudflare Workers and Vercel plugins) do not block QUERY, but verify your platform's ingress accepts the method — CloudFront, which fronts the app in the Lambda plugin's asset setup, does not forward it.
