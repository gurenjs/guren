---
'@guren/core': patch
---

`DatabaseApiTokenStore`, `DatabaseSessionStore` and `DatabaseOAuthStateStore` write each timestamp the way its column declares it: a Date for a drizzle timestamp-mode column, an ISO string for a text column, epoch milliseconds for an integer column with no mode. An `api_tokens` table declared with `text('created_at')`, the shape the SQLite scaffold gives `users`, made `createApiToken` throw at bind time (bun:sqlite cannot bind a Date) and surface as a 500, and `deleteExpired()` on such a table matched no row.
