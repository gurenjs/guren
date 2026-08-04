---
"@guren/server": minor
---

Accept middleware handler functions in `Router.middleware()` and
`RouteBuilder.middleware()`, alongside the registered alias names they already
took. Four guides across both doc languages — rate limiting, middleware, API
tokens, email verification — documented `router.post(path, action).middleware(
createRateLimitMiddleware())` and `router.middleware(handler).group(...)`, and
every one of those snippets failed to compile with `Argument of type
'MiddlewareHandler' is not assignable to parameter of type 'never'`.

Both call sites now take alias names, handlers, or a mix. They resolve by kind
rather than by position: every name in a route's chain runs before every
handler, across groups as well as within one call — so an inline handler on an
outer group runs after a named one on an inner group. Use aliases throughout
when relative order matters. Aliases are also the only form `guren audit` can
report by name; the guards it recognizes (`requireAuthenticated`,
`requireGuest`) are detected either way.

`Router.group()` and `middleware(...).group()` now throw when handed an `async`
callback, and `Router.group()` unwinds its prefix if the callback throws. Group
scopes are popped synchronously, so a callback that awaited before registering
its routes silently lost the prefix or middleware the group was opened with —
including auth guards. This was already the behavior for alias names; the fix
covers both.

`requireVerifiedEmail`'s `getUser` option typed its argument as `unknown`, so a
callback could not read the context at all. It now receives `{ get<T>(key) }` —
Hono's context idiom — with the type argument inferred from the expected
return, so the documented `getUser: async (ctx) => ctx.get('user')` compiles
without a cast. Callbacks written against the old `unknown` signature remain
assignable.
