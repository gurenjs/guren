---
'create-guren-app': patch
---

Scaffold starter tests with `TestApp.fromApp(app)`

The `default` and `blog` starter tests hand-wired what `fromApp()` does:
`await app.boot()` followed by `TestApp.fromFetch((request) => app.fetch(request))`.
Correct, but it is the first test a new app ever reads, and it teaches the arrow
wrapper as something the author has to remember — the arrow being load-bearing,
since `Application.fetch` reads instance state.

`@guren/testing@1.4.0` is published and the templates already admit it (`^1.4.0`),
so the scaffold now shows the short form.
