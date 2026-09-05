---
'@guren/server': minor
'@guren/core': minor
---

Let an endpoint declare that it authenticates without cookies, so CSRF does not
answer in place of its own 401

`Application.declareCookielessAuthPath(path)` records a path whose principal can
only come from a bearer token or an authority in front of the app. The CSRF
middleware reads the registry per request — it is created in
`AuthServiceProvider.register()`, long before such an endpoint mounts at boot —
and skips verification for an exact path match. Patterns are deliberately not
supported, and the registry is a second argument to `createCsrfMiddleware()`
rather than a `CsrfOptions` field, so it is framework wiring rather than a
second `exclude` an app can fill in. Apps exempting a path they chose themselves
still use `csrfOptions.exclude`.

A declaration naming a path the app already routes is refused with a warning:
the app's route is registered first and answers there, so honouring it would
leave a cookie-authenticated handler serving the path with CSRF disarmed while
the declaring endpoint sat unreachable behind it.
