---
'create-guren-app': minor
---

New apps start with a `guren.arch.ts` (RFC 0039 §8). Files under `resources/js/` may not import `drizzle-orm`, `postgres`, `mysql2`, `@guren/orm` or `@guren/core`, and a controller importing `drizzle-orm` is a warning, which `guren check --ci` and `guren gate` count like any other. The API-only starter carries the controller rule alone.
