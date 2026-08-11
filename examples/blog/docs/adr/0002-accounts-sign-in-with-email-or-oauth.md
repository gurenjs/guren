---
type: adr
status: stable
entities: [User]
related:
  - app/Http/Controllers/Auth/LoginController.ts
  - app/Http/Controllers/Auth/OAuthController.ts
generated: { by: "human:7nohe", at: 2026-08-11T11:19:25.406Z }
---

# Accounts sign in with email or OAuth

## Context

Readers should not need an account, but authors do — and forcing a
password on people who already live in GitHub or Google is friction.

## Decision

Sessions are cookie-based. Email plus password is the primary flow
(with registration, verification, and reset); GitHub and Google OAuth
link to the same User row via the provider id columns, so one person
is one account regardless of how they arrived.

## Consequences

Every gated route checks the same session, so middleware stays
uniform. Adding a provider means one more entry in the OAuth config,
not a parallel account model.
