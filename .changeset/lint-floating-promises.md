---
'@guren/server': patch
---

Await and report promises the framework used to drop on the floor, found by
the new `typescript/no-floating-promises` lint gate.

- `Application` now awaits an async `register()` on the optional providers it
  loads on demand (`mountDevEndpoint`), so `boot()` no longer runs
  before such a provider has finished registering.
- `Logger` attaches its error reporter to async channels: a channel whose
  `log()` rejects used to surface as an unhandled rejection, bypassing the
  `try`/`catch` that exists to keep logging failures from cascading. The
  check is duck-typed, so a promise from another realm counts too. A stack
  channel now calls every member, handles each member's rejection as soon as
  it is seen, and reports the failures once (an `AggregateError` when more
  than one member failed).
- The session middleware no longer `return`s from inside `finally`, which
  discarded whatever `next()` threw before the exception handler could see it.
