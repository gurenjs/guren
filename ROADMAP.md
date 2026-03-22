# Guren Roadmap Status (Alpha)

This document tracks the current status of the roadmap items listed in `README.md`.

## Status legend
- Planned: not started or only skeleton code exists
- In progress: partial implementation exists but key gaps remain
- Complete: core functionality implemented and tested

## Items

- Routing parity — **Complete**
  - Current: HTTP verbs, prefix groups, controller actions, route type generator, resource routes (`Route.resource`), named routes (`.name()`, `Route.route()`), scoped groups, route contracts with typed validation, route model binding (`bind: { id: Post }`).
  - Missing: none.
- Validation pipeline — **Complete**
  - Current: `validateRequest` middleware with Zod schema support, `getValidatedData` helper, customizable error handling, `parseRequestPayload` and `formatValidationErrors` utilities, `FormRequest` class, 49 built-in validation rules (`Validator` class with fluent field API, bail/nullable/sometimes/conditional rules), `quickValidate`/`quickValidateOrThrow` helpers.
- ORM features — **Complete**
  - Current: Drizzle adapter, `Model` with `find/where/orderBy/paginate`, full relationship suite (`hasMany`, `hasOne`, `belongsTo`, `belongsToMany`, `hasManyThrough`, `morphMany`, `morphTo`), eager loading via `with`/`withPaginate`, `QueryBuilder` with chainable API (`where`/`orWhere`/`whereIn`/`whereNotIn`/`whereNull`/`whereNotNull`/`orderBy`/`limit`/`offset`/`select`/`scope`/`count`/`first`/`firstOrFail`/`get`/`delete`/`update`/`paginate`), global scopes (`GlobalScopeRegistry`), soft deletes (`SoftDeletes` mixin), model observers (`ModelObserver`), attribute accessors/mutators, casts, fillable filtering, serialization.
  - Missing: relationship constraints/eager loading optimizations.
- Auth/authorization suite — **Complete**
  - Current: AuthManager + SessionGuard, middleware (`requireAuthenticated`/`requireGuest`), `make:auth` scaffolding with `--install` flag, `auth.useModel()` shorthand, auto-configured session middleware (`autoSession: true`), remember-me support, CSRF protection middleware, API tokens with abilities, password reset flow, email verification flow, policies and gates authorization.
  - Future: OAuth/social providers, additional guard drivers (JWT).
- Asynchronous tooling — **Complete**
  - Current: Queue system (Memory/Redis drivers, Job base class, Worker, failed job handling, retry/flush CLI), Event system (EventManager, Listener, built-in events, auto-discovery), Broadcasting (Memory/Redis drivers, public/private/presence channels, SSE middleware, auth middleware), Scheduler (cron parser, timezone support, fluent schedule API, overlap prevention, CLI list/run), Cache (Memory/Redis/File stores, tagged cache), Notifications (Mail/Database/Slack/Memory channels, queueable notifications).
  - Missing: more queue drivers (SQS, etc.), WebSocket broadcasting transport.
- Storage integrations — **Complete**
  - Current: StorageManager with Local, S3, and Memory drivers, file upload helpers, `storage:link` CLI command, visibility management, directory operations, temporary URLs.
  - Missing: additional cloud drivers (GCS, Azure Blob), streaming support.
- Database adapters — **In progress**
  - Current: Postgres and SQLite via Drizzle.
  - Missing: MySQL adapter.
- Developer experience — **Complete**
  - Current: `bunx guren` CLI with extensive generators (`make:auth`, `make:controller`, `make:model`, `make:middleware`, `make:migration`, `make:seeder`, `make:job`, `make:event`, `make:listener`, `make:mail`, `make:notification`, `make:channel`, `make:command`, `make:exception`, `make:factory`, `make:provider`, `make:resource`, `make:route`, `make:test`, `make:view`, `make:lang`), database commands (`db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback`, `db:status`), queue commands (`queue:work`, `queue:failed`, `queue:retry`, `queue:flush`), scheduling commands (`schedule:list`, `schedule:run`), routes type generation (`routes:types`, `codegen`), `route:list`, `config:cache`/`config:clear`/`config:show`, `storage:link`, `health:check`, `doctor` diagnostics, `upgrade`, `lang:publish`/`lang:list`, `dev` server, `add` blueprints for feature scaffolding, `create-guren-app` project creator with SSR/SPA modes.
  - End-to-end type safety: `bunx guren codegen` generates `pages.gen.ts` (Babel AST Props extraction → `PagePropsMap`), `routes.gen.ts` (typed `route()` helper), `data.gen.ts` (`Data` namespace from `JsonResource.toArray()`), `api-client.gen.ts` (typed `ApiRoutes` with `body` fields from Zod schemas). Route-level schema binding (`body`/`params`/`query`), route model binding (`bind: { id: Post }` + `this.model(Post)`), typed `<Link>`/`<Form>` components, bidirectional form types (`RouteBody`/`RouteErrors`), Vite HMR auto-regeneration.
- Database lifecycle commands — **Complete**
  - Current: `db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback` with safety checks, `db:status` for migration tracking.
- Release & compatibility policy — **In progress**
  - Current: SemVer commitment stated in CHANGELOG.
  - Missing: Bun/Node compatibility matrix, migration guides per minor.
- Documentation & learning — **In progress**
  - Current: guides/tutorials (getting started, deployment, authentication, relationships, validation, CSRF, error handling).
  - Missing: end-to-end tutorial path, deployment recipes verified and versioned.
- Quality & reliability — **In progress**
  - Current: CI on Bun (build, routes types, typecheck, tests), 99 test files with ~24,000 lines of test code covering server packages (auth, cache, queue, events, broadcasting, scheduling, storage, mail, notifications, i18n, logging, health, errors, container, console, http middleware, validation, resources, database), comprehensive testing utilities (`TestApp`, `TestClient`, `FakeMail`, `FakeEvent`, `FakeQueue`, mock auth helpers, database assertions, Inertia test helpers).
  - Missing: integration/E2E coverage, performance benchmarks.
- Community process — **Planned**
  - Current: Code of Conduct, Contributing guide.
  - Missing: Issue/PR templates, RFC workflow, release notes cadence.
- First-party plugins — **Complete**
  - Current: Auth (scaffolding, auto-session, API tokens, password reset, email verification, policies/gates), Mail (SMTP, Resend transports), Queue (Memory/Redis), Cache (Memory/Redis/File, tagged cache), Notifications (Mail, Database, Slack, Memory channels), Broadcasting (Memory/Redis, SSE), Scheduler (cron, fluent API), Logging (Console, File, DailyFile channels), i18n (JSON loader, pluralization, namespaces), Health checks (Database, Redis, Cache, Storage, Memory, custom), Console commands (full Artisan-style kernel), Container/DI (bind/singleton/scoped/tag/alias/fake/contextual bindings), Error handling (HttpException, ExceptionHandler, debug page), Rate limiting middleware (fixed window, sliding window, Redis store), Encryption (AES-GCM/CBC, hashing, HMAC, random generation), Facades, Auto-discovery (providers, listeners, jobs), API Resources (JsonResource, ResourceCollection, Paginator, CursorPaginator).
  - Missing: additional mail transports, more notification channels (SMS, push).
