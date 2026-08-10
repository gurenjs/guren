---
'@guren/testing': minor
'@guren/server': minor
---

Add `TestApp.fromApp(app)` and make `Application.boot()` idempotent

Testing against the real application required
`await app.boot(); TestApp.fromFetch((request) => app.fetch(request))` — and
the arrow wrapper is load-bearing, because an unbound `app.fetch` reference
throws (`Application.fetch` reads instance state). `TestApp.fromApp(app)`
boots the app and binds fetch, removing both the boilerplate and the footgun.

`Application.boot()` now reuses its first call, so booting twice is a no-op
rather than mounting security middleware and routes a second time. This also
covers two callers booting concurrently, which the previous code could not:
each saw an unbooted app and mounted everything again. A boot that throws is
not remembered, so a later call attempts boot again — it resumes on a
partially mounted app rather than starting clean, which is how the Cloudflare
Workers handler has always treated it.

This is a behavior change to a public method: a second `boot()` used to
duplicate the middleware chain and now does nothing.
