---
"@guren/cli": patch
---

`guren make:auth --oauth` keeps OAuth state in the database. It adds an `oauth_states` table to `db/schema.ts` for the app's dialect, covered by the same migration as `users` and `sessions`, and the scaffolded `OAuthProvider` binds `createOAuthManager({ stateStore: new DatabaseOAuthStateStore(oauthStates) })` itself. `--install` no longer registers `CoreOAuthServiceProvider`, whose manager kept state in process memory, so on Workers, Lambda and Vercel the authorize redirect and the callback could reach different instances and the sign-in failed. An app with no `db/schema.ts` keeps the previous wiring.

An app scaffolded by an earlier release is not changed by re-running with `--force`: `OAuthProvider.ts` is rewritten, but `CoreOAuthServiceProvider` stays in the providers array. The scaffolded provider binds after it, so the database store still wins; remove the entry by hand.

The deploy-runtime warning for in-memory OAuth state now suggests the OAuth state store alone. It used to also suggest `guren add session`, which an app from `make:auth` has already run.

`make:auth` lists `bun run codegen` as its first next step. Until it runs, `.guren/pages.gen.ts` does not list the auth pages and `bun run typecheck` fails.
