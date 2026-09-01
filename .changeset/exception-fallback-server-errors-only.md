---
'@guren/server': patch
---

Stop reporting handled client errors as `Unhandled exception:`.

`ExceptionHandler.reportException()` falls back to `console.error('Unhandled exception:', error)` when an app registers no reporter, so that a hosted runtime — where stdout is the only channel back to the operator — does not turn a 500 into a rendered page and nothing else. That fallback fired for *every* exception reaching the handler, including the 4xx an application throws on purpose: a `ValidationException` from `validateBody()`, an `AuthorizationException` from an authorization middleware, an `HttpException.notFound()`. A route rejecting invalid input as designed printed a full stack trace per request, labelled as though nothing had handled it.

The label was the misleading part. Nothing escapes: the exception is caught by the handler's own middleware, `reportException()` is awaited inside `handle()`, and the correct 4xx is returned. Confirmed on Node 22 under `--unhandled-rejections=strict` against the built `dist` — no `unhandledRejection`, no `uncaughtException`, exit 0 — so this was never a crash risk on `@guren/plugin-lambda` or `@guren/plugin-vercel`, only noise loud enough to read as one.

The gate is on the console fallback alone, **not** on `shouldNotReport()`: a registered reporter still receives 4xx, because an app tracking auth failures or validation churn through one is asking for exactly those. The status it reads comes from a single `resolveExceptionStatus()`, which `renderDefaultException` now also takes its status from rather than from `toResponse()` — what an exception is delivered as and whether it counts as a server failure must be the same number, or an exception could be sent as a 422 and reported as a crash. An error carrying no status is still a 500, so a bare `throw new Error(...)` logs exactly as before.
