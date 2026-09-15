---
"@guren/cli": patch
---

`guren add oauth` keeps OAuth state in the database. It adds an `oauth_states` table to `db/schema.ts` for the app's dialect and generates its migration, and the scaffolded `OAuthProvider` binds `createOAuthManager({ stateStore: new DatabaseOAuthStateStore(oauthStates) })` itself. The blueprint no longer registers `CoreOAuthServiceProvider`, whose manager kept state in process memory, so on Workers, Lambda and Vercel the authorize redirect and the callback could reach different instances and the sign-in failed.

An app with no `db/schema.ts` is refused before anything is written, since the provider imports the table.

Re-running with `--force` in an app scaffolded by an earlier release rewrites `OAuthProvider.ts` but leaves `CoreOAuthServiceProvider` in the providers array. The scaffolded provider binds after it, so the database store still wins; remove the entry by hand.
