---
"@guren/testing": minor
---

`createGurenControllerModule()` now covers server-rendered content pages
(RFC 0014): the mock `Controller.view()` delegates to the real
`renderDocument()` from `@guren/server` (fragment guard, escaping, and
response shaping included, so the mock cannot drift), and the mocked module
exports the real `viteAsset()` — under vitest it takes the deterministic
dev branch, and a test that forces production gets the real manifest lookup
including the missing-entry throw. The `hono` peer floor moves to `^4.13.0`
in line with `@guren/server`.
