---
'@guren/cli': minor
---

`make:auth --oauth` now scaffolds truly passwordless OAuth accounts (RFC 0003 Part 3): OAuth-created users are stored without a password instead of hashing a synthetic random one — the model's hashing pipeline already skips absent passwords, and password login safely rejects accounts without a hash (timing-equalized). On CPU-metered runtimes (Cloudflare Workers free tier), this also removes the one scrypt hash per OAuth signup that would have blown the request budget.

The scaffolded `users` table now leaves `passwordHash` nullable when `--oauth` is enabled, and adding `--oauth` to an existing password-auth app relaxes the existing `notNull` in `db/schema.ts` (run `db:make` to generate the migration; the relaxation is scoped to the `users` table and handles every dialect, including mysql's comma-carrying `varchar` options). Note the trade-off: because `--oauth` still scaffolds password login alongside, the relaxation is table-wide — password-registered rows lose the database-level NOT NULL guard (the scaffold prints this). Pass `--oauth-only` to drop password login entirely instead. The email-collision message is provider-agnostic now ("Sign in with the method you originally used").
