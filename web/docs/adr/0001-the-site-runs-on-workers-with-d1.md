---
type: adr
status: stable
entities: [Post, User]
related:
  - wrangler.jsonc
  - config/database.ts
  - db/schema.ts
  - scripts/cloudflare-build.ts
verified: { by: human:7nohe, at: 2026-11-21T13:19:14Z }
---

# The site runs on Workers with D1

## Context

The site was a documentation site deployed to Vercel. Adding a blog gave it
a database, and a separate managed Postgres would have been a second
platform to provision for one small table set.

The framework had no Workers adapter at the time. Running its own site on
one was the way to find out what the adapter needed (RFC 0003).

## Decision

guren.dev runs as one Worker with a D1 database bound to it. The schema is
written once, in the SQLite dialect D1 speaks. `config/database.ts` picks
the driver by runtime: D1 on Workers, a local SQLite file under Bun.

Migrations are applied out of band by wrangler. The Worker never probes the
filesystem for them at boot.

## Consequences

The Worker and its static assets deploy as one unit. D1 is updated by
separate steps that run first (the migrations, then the search index), and
a Worker deploy that fails or is rolled back does not undo them.

The free plan's limits become design constraints: CPU per request, D1
writes a day, Analytics Engine data points a day.

Code that needs Bun or a filesystem cannot run in a request. Whatever does
is moved to build time or stubbed in `wrangler.jsonc`, and the CPU budget
rules out hashing a password (ADR 0004).

Local development runs on Bun with SQLite, so a D1-only behaviour shows up
under `wrangler dev` and not under `bun run dev`.
