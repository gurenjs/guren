---
'@guren/server': minor
---

Expose the bound address on the application as `app.address`

`Application.listen()` returns `{ port, hostname, url }`, but the instance kept
only its private Bun server, so the address was available in exactly one place:
whatever received `listen()`'s return value. Anything else that needs it — an
OpenAPI `servers` entry, an absolute URL builder, a health report — had to have
it threaded in from the entrypoint. The example API did this with a module-local
variable and an exported setter re-exported through two files so that
`bin/serve.ts` could push the address back down into the app that had just
produced it. Every app mounting OpenAPI docs would have hand-rolled the same
wiring.

`app.address` now returns the same `ListenAddress` `listen()` returned, and
`undefined` before `listen()`. It reads a value stored at bind time rather than
re-deriving one from the live server, because `listen()` resolves the port
through a fallback the socket no longer carries; the wildcard-host mapping
(`0.0.0.0` → `127.0.0.1`, `::` → `::1`) stays in the single helper `listen()`
already uses. `ListenAddress`'s fields are now `readonly`, since the object
`listen()` hands back is the one every later reader sees.

It reverts to `undefined` when the server is superseded or torn down through
the framework — a later `listen()`, including one whose rebind fails, and the
process-exit teardown. A server stopped by calling `stop()` on the Bun server
directly leaves no signal behind, so the accessor keeps reporting its address:
it answers "where did `listen()` put this app", not "is this app healthy".

This does not replace passing a function to `@guren/openapi`'s `servers`
option. Late resolution is what lets the document name an address the app did
not have at mount time, and a function is the only form available when mounting
against a plain Hono instance rather than an `Application`.
