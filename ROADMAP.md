# Guren Roadmap Status (Alpha)

This document tracks the current status of the roadmap items listed in `README.md`.

## Status legend
- Planned: not started or only skeleton code exists
- In progress: partial implementation exists but key gaps remain

## Items

- Routing parity — **Planned**
  - Current: HTTP verbs + prefix groups in `Route`; controller actions resolved; route type generator exists.
  - Missing: resource routes, named routes, scoped groups, implicit model binding.
- Validation pipeline — **Planned**
  - Current: request payload parser and Zod-style error formatter helper.
  - Missing: centralized validation layer/middleware, form request helpers, reusable rules.
- ORM features — **In progress**
  - Current: Drizzle adapter, `Model` with `find/where/orderBy/paginate`, `hasMany/belongsTo`, simple eager loading via `with/withPaginate`.
  - Missing: scopes, soft deletes, observers/events, richer relationship types and constraints.
- Auth/authorization suite — **In progress**
  - Current: AuthManager + SessionGuard, middleware (`requireAuthenticated`/`requireGuest`), `make:auth` scaffolding with `--install` flag for auto-wiring, `auth.useModel()` shorthand API, session management with remember-me support.
  - Missing: OAuth/social providers, password reset flows, email verification, API tokens, policies/gates, guard drivers beyond session (e.g., JWT, API token), **CSRF protection middleware + form helpers**.
- Asynchronous tooling — **Planned**
  - Missing: queues, events, broadcasting, scheduler, cache abstractions.
- Storage integrations — **Planned**
  - Missing: S3/D1 drivers, storage abstraction layer, upload helpers.
- Database adapters — **Planned**
  - Current: Postgres via Drizzle.
  - Missing: MySQL/SQLite adapters and configuration.
- Developer experience — **In progress**
  - Current: `bunx guren` CLI with make:* generators, routes type generation, runtime commands, dev server helpers.
  - Missing: artisan-style suite coverage, guardrails (prompts, force flags), richer testing helpers, polished error messages.
- Database lifecycle commands — **Planned**
  - Current: migrate/seed helpers in CLI.
  - Missing: `db:reset`, `db:rollback` with safety checks.
- Release & compatibility policy — **Planned**
  - Missing: SemVer commitment, Bun/Node compatibility matrix, migration guides per minor.
- Documentation & learning — **In progress**
  - Current: guides/tutorials (getting started, deployment, authentication, relationships, etc.).
  - Missing: opinionated quickstart, end-to-end tutorial path, troubleshooting, deployment recipes (Docker/Edge/Serverless) verified and versioned.
- Quality & reliability — **In progress**
  - Current: CI on Bun (build, routes types, typecheck, tests), unit tests for server/orm basics.
  - Missing: integration/E2E coverage (routes, Inertia SSR, ORM), performance/footprint benchmarks, nightly/canary runs.
- Community process — **Planned**
  - Current: Code of Conduct, Contributing guide.
  - Missing: Issue/PR templates, RFC workflow, release notes cadence.
- First-party plugins — **In progress**
  - Current: auth scaffolding with auto-installation, session middleware with configurable options, `auth.useModel()` helper for simplified provider registration.
  - Missing: mail/queue/cache drivers, job scheduler, alternative ORM/DB adapter examples, event broadcasting.
