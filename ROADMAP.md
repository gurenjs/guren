# Guren Roadmap Status (Alpha)

This document tracks the current status of the roadmap items listed in `README.md`.

## Status legend
- Planned: not started or only skeleton code exists
- In progress: partial implementation exists but key gaps remain
- Complete: core functionality implemented and tested

## Items

- Routing parity — **Complete**
  - Current: HTTP verbs, prefix groups, controller actions, route type generator, resource routes (`Route.resource`), named routes (`.name()`, `Route.route()`), scoped groups.
  - Missing: implicit model binding.
- Validation pipeline — **Complete**
  - Current: `validateRequest` middleware with Zod schema support, `getValidatedData` helper, customizable error handling, `parseRequestPayload` and `formatValidationErrors` utilities.
  - Future: form request classes, reusable validation rules.
- ORM features — **In progress**
  - Current: Drizzle adapter, `Model` with `find/where/orderBy/paginate`, `hasMany/belongsTo`, simple eager loading via `with/withPaginate`.
  - Missing: scopes, soft deletes, observers/events, richer relationship types and constraints.
- Auth/authorization suite — **Complete**
  - Current: AuthManager + SessionGuard, middleware (`requireAuthenticated`/`requireGuest`), `make:auth` scaffolding with `--install` flag, `auth.useModel()` shorthand, auto-configured session middleware (`autoSession: true`), remember-me support, CSRF protection middleware, API tokens with abilities, password reset flow, email verification flow, policies and gates authorization.
  - Future: OAuth/social providers, additional guard drivers (JWT).
- Asynchronous tooling — **In progress**
  - Current: Queue system (Memory/Redis drivers, Job base class, Worker, failed job handling), Event system (EventManager, Listener, built-in events), Broadcasting (Memory/Redis drivers, public/private/presence channels), Scheduler (cron expressions, timezone support), Cache (Memory/Redis/File stores, tagged cache).
  - Missing: more queue drivers (SQS, etc.), WebSocket broadcasting integration.
- Storage integrations — **In progress**
  - Current: StorageManager with Local, S3, and Memory drivers, file upload helpers.
  - Missing: additional cloud drivers (GCS, Azure Blob), streaming support.
- Database adapters — **Planned**
  - Current: Postgres via Drizzle.
  - Missing: MySQL/SQLite adapters and configuration.
- Developer experience — **In progress**
  - Current: `bunx guren` CLI with extensive generators (`make:auth`, `make:controller`, `make:model`, `make:middleware`, `make:migration`, `make:seeder`, `make:job`, `make:event`, `make:listener`, `make:mail`, `make:notification`, `make:channel`, `make:command`, `make:exception`, `make:factory`, `make:provider`, `make:resource`, `make:route`, `make:test`, `make:view`), database commands (`db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback`, `db:status`), queue commands (`queue:work`, `queue:failed`, `queue:retry`, `queue:flush`), routes type generation.
  - Missing: interactive prompts, more guardrails.
- Database lifecycle commands — **Complete**
  - Current: `db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback` with safety checks, `db:status` for migration tracking.
- Release & compatibility policy — **In progress**
  - Current: SemVer commitment stated in CHANGELOG.
  - Missing: Bun/Node compatibility matrix, migration guides per minor.
- Documentation & learning — **In progress**
  - Current: guides/tutorials (getting started, deployment, authentication, relationships, validation, CSRF, error handling).
  - Missing: end-to-end tutorial path, deployment recipes verified and versioned.
- Quality & reliability — **In progress**
  - Current: CI on Bun (build, routes types, typecheck, tests), comprehensive unit tests for server packages (auth, cache, queue, events, broadcasting, scheduling, storage, mail, notifications, i18n, logging, health, errors, container, console, http middleware).
  - Missing: integration/E2E coverage, performance benchmarks.
- Community process — **Planned**
  - Current: Code of Conduct, Contributing guide.
  - Missing: Issue/PR templates, RFC workflow, release notes cadence.
- First-party plugins — **In progress**
  - Current: Auth (scaffolding, auto-session, API tokens, password reset, email verification, policies/gates), Mail (SMTP, Resend transports), Queue (Memory/Redis), Cache (Memory/Redis/File), Notifications (Mail, Database, Slack, Memory channels), Broadcasting (Memory/Redis), Scheduler, Logging (Console, File, DailyFile channels), i18n (JSON loader, pluralization), Health checks (Database, Redis, Cache, Storage, Memory), Console commands, Container/DI, Error handling (HttpException, ExceptionHandler), Rate limiting middleware.
  - Missing: additional mail transports, more notification channels (SMS, push).
