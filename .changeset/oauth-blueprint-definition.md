---
'@guren/cli': minor
'create-guren-app': patch
---

`guren add oauth` and `guren make:auth --oauth` write `config/oauth.ts` as a `defineOAuthConfig` definition listed in `createApp({ config })` when the app declares its environment in `config/env.ts` and nothing already binds OAuth (RFC 0027 §2). The definition replaces `OAuthProvider` and `CoreOAuthServiceProvider`, keeps state in `oauth_states` when the app has a schema, and registers a provider once its `OAUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET` and `_REDIRECT_URI` keys, which the commands declare, are all set. The deploy-runtime check reads `defineOAuthConfig` as OAuth. Both forms now append those keys to `.env.example` and `.env`, so the starter `.env.example` files no longer carry them commented out; a blueprint key an existing `.env.example` only comments out is reported instead of being skipped silently.
