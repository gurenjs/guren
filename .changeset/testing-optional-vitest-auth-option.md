---
"@guren/testing": minor
---

Add `auth` option to `TestApp.create()`, mirroring `createApp({ auth: {} })`, so tests can opt into real session + CSRF middleware instead of the CSRF-bypassing bare app.

Fix `@guren/testing`'s main entry statically importing `vitest` (via `src/database.ts`) even though `vitest` is an optional peer dependency — importing `TestApp` (or any other main-entry export) previously failed to resolve without `vitest` installed. `useDatabaseTransactions()`/`useTruncateTables()` now resolve their `beforeEach`/`afterEach` hooks through a small runner-agnostic registry: bun:test's injected globals are picked up automatically, and vitest users register hooks by importing `@guren/testing/vitest` once in test setup (already required for `configureInertiaVitest()`).

**Migration note for existing vitest users:** if you call `useDatabaseTransactions()`/`useTruncateTables()` under vitest without already importing `@guren/testing/vitest` in your setup file, add that import — otherwise these helpers now throw instead of silently working via vitest's ambient `beforeEach`/`afterEach`.
