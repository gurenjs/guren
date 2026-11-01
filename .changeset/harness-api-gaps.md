---
"@guren/cli": patch
---

The agent harness documents what agents kept looking up in `node_modules`: `assertInertia` needs `http.json()`, faking mail and queues on the app's container, registering a policy in a provider's `boot()` and the bare-class form for abilities with no record (`this.authorize('create', Post)`), and, in the `guren plan` prompt, that a view or model reference is an element id rather than a page path or class name. The feature skill mentions prototype mode. Doc pointers in the harness and in `guren context` now go to `https://guren.dev/docs/guides/<slug>` instead of files in the framework repository, and the scheduling hint printed by `guren add` no longer links to a 404.
