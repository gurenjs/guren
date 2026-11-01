---
'@guren/testing': patch
---

`TestApp.actingAs()`, and `actingAs()` / `withSession()` on a `createTestClient()` request, accept a user or session holding any Unicode. The `X-Testing-User` and `X-Testing-Session` headers carried raw JSON, so a user named `浦田` made Bun throw `Header has invalid value` and a Latin-1 `é` reached the server mangled. Every character past ASCII is now written as a JSON `\uXXXX` escape. The header is still plain JSON, so this works against every `@guren/server` the package already supports.
