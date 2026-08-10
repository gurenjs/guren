---
'@guren/testing': minor
'@guren/server': minor
---

Add `TestApp.fromApp(app)` and expose `Application.booted`

Testing against the real application required
`await app.boot(); TestApp.fromFetch((request) => app.fetch(request))` — and
the arrow wrapper is load-bearing, because an unbound `app.fetch` reference
throws (`Application.fetch` reads instance state). `TestApp.fromApp(app)`
binds fetch internally and boots the app when it has not booted yet, removing
both the boilerplate and the footgun.

Boot-once semantics: `Application` now reports a read-only `booted` flag,
which `fromApp()` trusts — an app booted elsewhere is not booted again (a
second `boot()` would mount routes and middleware twice). For app-like objects
without the flag, `fromApp()` tracks the instances it booted itself and still
boots each at most once across calls.
