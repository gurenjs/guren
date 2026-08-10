---
'@guren/server': patch
---

Apply the security defaults to every response, including raw ones

Two independent gaps meant the framework's own asset responses carried neither
host authorization nor a single security header.

`Application.boot()` mounted the security defaults, but the scaffolded templates
call `autoConfigureInertiaAssets(app, …)` at module scope in `src/main.ts` —
before `bootstrap()` awaits `boot()`. Hono composes matched handlers in
registration order, so those asset routes ran ahead of the `use('*')` middleware
and answered without ever entering it. With the template's development host
authorization (`allowedHosts: ['localhost:*', '127.0.0.1:*']`) and `bin/serve.ts`
binding `0.0.0.0`, `GET /` from a LAN peer was refused with 403 while
`GET /resources/js/pages/Home.tsx` returned 200. The same ordering applied in
production to `/public/*` and the root asset catch-all.

`mountSecurityDefaults()` now runs in the `Application` constructor, which is the
one position an application cannot register in front of. A double `boot()` no
longer double-mounts the middleware either.

Separately, `createSecurityHeaders`, `createForceHttpsMiddleware` and
`createCspMiddleware` wrote their headers with `ctx.header(...)` before
`await next()`. Hono keeps those in prepared headers and merges them only when
the handler answers through the context; a handler returning a raw
`new Response(...)` replaces `ctx.res` outright and drops them — which is every
asset response the framework serves, and any application controller that returns
a `Response` directly. All three now apply their headers after the response
exists, through a shared `applyResponseHeaders`, which sets a header only when
the response does not already carry it. Precedence is unchanged: a handler's own
value, or an inner middleware's stronger `Strict-Transport-Security`, still wins.
