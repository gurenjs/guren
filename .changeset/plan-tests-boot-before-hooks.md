---
"@guren/cli": patch
---

`plan:scaffold` test skeletons boot the application in a `beforeAll`, through a new `ready()` helper, instead of lazily in the first `client()` call. A `beforeEach` that creates or clears rows now runs against a configured database rather than failing every case with `DrizzleAdapter: database has not been configured`. The hook waits up to 120 seconds for the boot, past Bun's 5-second default. A boot that fails is printed there rather than thrown, so `plan:verify` records the step `blocked` whatever the implementer's hooks do, and each test still fails by name with it.
