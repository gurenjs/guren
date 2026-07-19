---
'@guren/core': minor
---

Add `DatabaseApiTokenStore`, a database-backed `ApiTokenStore` built on the Guren ORM. Pass the Drizzle table for your `api_tokens` schema and it plugs into `createApiToken`/`verifyApiToken` and the bearer-token middleware with no custom store code, using the app's configured ORM connection. Includes `deleteExpired()` for scheduled pruning and an `abilitiesMode: 'text'` option for plain-text JSON ability columns (JSON-capable columns are the default). The API tokens guide previously told users to hand-roll this class — it now documents the built-in store and the recommended schema.
