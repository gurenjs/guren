---
'@guren/server': minor
---

Type the rate limiter's `statusCode` option as Hono's `ContentfulStatusCode`.

The option was `number`, and the default handler passed it to `ctx.json()`
through `statusCode as 429` — a cast asserting the value the caller chose is
the literal 429. So nothing checked a custom status, and the codes that
cannot carry a body (204, 205, 304) type-checked and then failed at runtime
when the limiter tried to send a JSON body with one.

`statusCode` now carries the type `ctx.json()` accepts, so those are compile
errors at the call site instead. `ContentfulStatusCode` is re-exported from
`@guren/core` beside the other rate limiting types.

This ships as a minor deliberately, on the reading v2.10.0 applied to
`ApplicationOptions.discover`: it is a type-surface fix rather than an API
change. Nothing about the runtime moved, every status the limiter could
actually send is still accepted, and a literal — which is how the option is
written in the guides and in every example — is unaffected. The narrow case
that now needs a change is a status arriving as a plain `number` (read from
config, say), which needs a narrowing or a cast at the call site.

Also makes the sliding-window store's `timestamps` a `const`; no branch
reassigned it.
