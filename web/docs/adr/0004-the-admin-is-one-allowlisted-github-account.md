---
type: adr
status: stable
entities: [User]
related:
  - modules/blog/app/Services/admin-allowlist.ts
  - modules/blog/app/Http/Controllers/Auth/OAuthController.ts
  - modules/blog/app/Providers/AuthProvider.ts
  - db/schema.ts
verified: { by: human:7nohe, at: 2026-11-21T13:05:19Z }
---

# The admin is one allowlisted GitHub account

## Context

The blog has one author. Its admin needs a sign-in, and the Workers free
plan gives a request 10 ms of CPU, which no credible password hash fits in
(RFC 0003 §4).

## Decision

Sign-in is GitHub OAuth only. `BLOG_ADMIN_GITHUB_ID` names the one account
that may sign in, and the callback checks it before it looks up or creates
any user.

In production an unset variable means nobody may sign in. In development
an unset variable accepts any account.

Accounts carry no password hash. `passwordColumn` stays configured so the
guard rejects a password login for such an account.

## Consequences

No request hashes a password, and there is no registration or password
reset to maintain.

A variable missed during a deploy locks the admin out. It does not hand
post management to whoever signs in first.

A second author needs a new decision: the allowlist holds one id, and
nothing models roles.
