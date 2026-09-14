---
"@guren/cli": patch
---

The `code-review` subagent the agent harness installs now runs `guren check` and `guren audit` and reviews what they do not settle: validation on every mutating route, a resource in front of every record, route registration order, and authorization through a policy. Its checklist and `test-writer`'s examples are corrected against the current framework — `defineModel(table)`, `events.listen(...)` in the app's event provider, `TestApp.fromApp(app)` with CSRF primed on every mutating request, and `fakeEvent`/`fakeQueue` bound through their managers. The `testing` rule every agent target receives carries the CSRF rule too.
