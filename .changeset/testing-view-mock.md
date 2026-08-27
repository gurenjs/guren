---
"@guren/testing": minor
---

`createControllerModuleMock()` now covers server-rendered content pages
(RFC 0014): the mock `Controller` implements `view()` by rendering through
the real hono runtime (via the declared `hono` peer, floor now `^4.13.0`) —
mirroring `renderDocument()` in `@guren/server` including the
forgotten-Layout guard — and the mocked module exports a `viteAsset()` whose
dev branch is the real rule and whose production branch maps the entry
identically under `/public/assets/` (unit tests have no manifest to read).
