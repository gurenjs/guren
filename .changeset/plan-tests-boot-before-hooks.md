---
"@guren/cli": patch
---

`plan:scaffold` test skeletons boot the application in a `beforeAll`, through a new `ready()` helper, instead of lazily in the first `client()` call. A `beforeEach` that creates or clears rows now runs against a configured database rather than failing every case with `DrizzleAdapter: database has not been configured`. A boot that fails is kept rather than thrown in the `beforeAll`, so each test still fails by name with it and `plan:verify` still records the step `blocked`; the header comment tells the implementer to open their own `beforeEach` with `await ready()` so that holds for their hook too.
