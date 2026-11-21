---
type: adr
status: stable
entities: [User]
related:
  - config/session.ts
  - config/oauth.ts
  - db/schema.ts
verified: { by: human:7nohe, at: 2026-11-21T13:19:14Z }
---

# Sessions and OAuth state live in D1

## Context

A Worker's memory belongs to one isolate. The request that starts a GitHub
sign-in and the callback that finishes it can land on different isolates,
and so can the login redirect and the next page view. The framework's
in-memory defaults lose both.

## Decision

The session store is the `database` driver over the `sessions` table, and
the OAuth state store is `DatabaseOAuthStateStore` over `oauth_states`.
Both tables are in the same D1 database as the posts.

A `cookie` session store is declared as an alternative. Selecting it means
adding `SESSION_DRIVER` to `wrangler.jsonc` and deploying again.

## Consequences

A session is first stored only once a handler writes to it, which signing
in does. After that, each request carrying its cookie costs a read and a
write: an untouched session still has its expiry rolled forward with one
`UPDATE`. Both follow the admin and not the visitors, who carry no session
cookie.

A session can be revoked by deleting its row. The `cookie` store cannot do
that, which is why only ids would belong in it.

If D1 is unavailable, nobody can sign in.
