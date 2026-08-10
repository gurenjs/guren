---
'@guren/plugin-cloudflare': patch
---

Clear the captured Workers env when `boot()` throws synchronously

`createWorkersHandler` boots on the first request and, when that boot fails,
drops both the shared boot promise and the write-once env holder so the retry
starts from the new request's bindings. The `app.boot()` call sat one line
above the `try`, so only a *rejected promise* reached that cleanup. An
implementation that throws before returning a promise skipped it, leaving the
holder populated with the failed request's `env` — and since the holder is
first-call-wins, every later request would then boot against those stale
bindings, which is the exact failure the catch exists to prevent.

`Application.boot()` is `async` and so cannot reach this, but the handler
publishes `WorkersAppLike`, a structural type requiring only
`boot(): Promise<void>`; a conforming non-async implementation can throw
synchronously. The call now happens inside the `try`. On a synchronous throw
the assignment never runs, so the promise is already `undefined` and the
existing reset stays a no-op.

`@guren/plugin-vercel`'s `createVercelHandler` is not affected on either count:
it is an `async` function, which converts a synchronous throw into a rejection,
and it keeps no module-scope env holder to leave stale.
