---
'@guren/cli': minor
---

`guren make:auth --oauth <providers>` now scaffolds OAuth login buttons for a comma-separated list of providers (`github`, `google`, `discord`). It adds a `<provider>Id` column per provider to the `users` table, an `OAuthProvider` that registers each provider against the shared `OAuthManager` (only once its client ID, secret, and redirect URI are all set), and an `OAuthController` with `redirectToProvider`/`callback` actions — sharing file paths and DI wiring conventions with `guren add oauth`, but with a complete callback that links or creates the account and logs the user in instead of a stub. Unlike `--verify`, `--oauth` works with `--minimal`. Also generalizes `updateSchema()`'s column-injection logic so `--verify` and `--oauth` can add their columns together without duplicating the `users` table.
