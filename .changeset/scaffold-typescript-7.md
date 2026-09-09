---
'create-guren-app': minor
---

Scaffolded apps depend on `typescript@^7` (the native compiler). `bun run typecheck`, and the typecheck stage of `guren gate`, drop from seconds to well under one on a fresh app — measured 2.7–5.3 s → 0.4 s on a fourteen-chapter tutorial app, with the same diagnostics.
