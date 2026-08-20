---
"@guren/testing": minor
---

`createControllerModuleMock()` now includes a `definePlugin` stub mirroring the real factory shape, so controllers that (transitively) import a plugin package load under a mocked `@guren/core`.
