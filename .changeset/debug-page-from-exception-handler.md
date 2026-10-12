---
'@guren/server': minor
'@guren/cli': patch
---

The exception handler now renders the development debug page (stack trace, request, environment) for a browser request that ends in a 5xx while debug details are on, where it used to answer with the JSON body. Inertia visits, XHRs and JSON callers keep the JSON body with `exception` and `stack`, and a 4xx gets the plain error page with its message in development as in production.

### Deprecated

- **`debugErrorMiddleware()`**: Hono hands a handler's error to the app's `onError`, where `ErrorServiceProvider` installs the exception handler, so the middleware's `catch` never saw an error in a Guren app. Remove it; the exception handler renders the same page. It warns once per process, and will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `debug-error-middleware`.
