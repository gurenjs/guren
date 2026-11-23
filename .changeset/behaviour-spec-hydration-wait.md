---
'@guren/cli': patch
---

A generated behaviour spec waits for the page to hydrate before it acts. It opened the start page with `app.open()`, which returns at the `load` event, while the client mounts after it. A step taken in between submitted the form natively, with no CSRF token, and landed on the 419 "Page Expired" page. A recorded step replays with no model call, so a replay on a slow machine was the run that met it, and the failed replay then replaced the recording. The spec now opens the page with `browser.goto(…, { waitUntil: 'networkidle' })`, as the sign-in setup does.

**Recordings have to be made again.** The line is part of each test's body, so `bunx guren browser:map` gives every behaviour test a new title and its recording a new key. Run `bunx guren browser:map`, then `bun run test:behaviours` under your agent's login, and commit `.e2e/cache/`; until then `bun run test:behaviours:ci` exits 3, since each agent step has no recording and finds no login (`MODEL_PROVIDER_FAILED`). The recordings under the old titles stay on disk until `bunx e2e cache clear`. A test performed with locator steps has no recording and needs nothing. A page that keeps a request open (an `EventSource`, a long poll) never goes quiet, so its test times out on opening it.
