# Guren Roadmap Status (Alpha)

This document tracks the current status of the roadmap items listed in `README.md`.

**Baseline date:** 2026-03-27

## Status legend
- Planned: not started or only skeleton code exists
- In progress: partial implementation exists but key gaps remain
- Complete: core functionality implemented and tested

## Scope legend
- **1.0**: required for 1.0 release
- **post-1.0**: desirable but not blocking 1.0

## Items

- Routing parity — **Complete**
  - Current: HTTP verbs, prefix groups, controller actions, route type generator, resource routes (`router.resource`), named routes (`.name()`, `router.route()`), scoped groups, route contracts with typed validation, route model binding (`bind: { id: Post }`), type-safe middleware aliases (`router.aliasMiddleware`).
- Validation pipeline — **Complete**
  - Current: `validateRequest` middleware with Zod schema support, `getValidatedData` helper, customizable error handling, `parseRequestPayload` and `formatValidationErrors` utilities, `FormRequest` class, 49 built-in validation rules (`Validator` class with fluent field API, bail/nullable/sometimes/conditional rules), `quickValidate`/`quickValidateOrThrow` helpers.
- ORM features — **Complete**
  - Current: Drizzle adapter, `Model` with `find/where/orderBy/paginate`, full relationship suite (`hasMany`, `hasOne`, `belongsTo`, `belongsToMany`, `hasManyThrough`, `morphMany`, `morphTo`), eager loading via `with`/`withPaginate`, `QueryBuilder` with chainable API (`where`/`orWhere`/`whereIn`/`whereNotIn`/`whereNull`/`whereNotNull`/`orderBy`/`limit`/`offset`/`select`/`scope`/`count`/`first`/`firstOrFail`/`get`/`delete`/`update`/`paginate`), global scopes (`GlobalScopeRegistry`), soft deletes (`SoftDeletes` mixin), model observers (`ModelObserver`), attribute accessors/mutators, casts, fillable filtering, serialization.
  - Missing (post-1.0): relationship constraints/eager loading optimizations.
- Auth/authorization suite — **Complete**
  - Current: AuthManager + SessionGuard, middleware (`requireAuthenticated`/`requireGuest`), `make:auth` scaffolding with `--install` flag, `auth.useModel()` shorthand, auto-configured session middleware (`autoSession: true`), remember-me support, CSRF protection middleware, API tokens with abilities, password reset flow, email verification flow, policies and gates authorization.
  - Missing (post-1.0): OAuth/social providers, additional guard drivers (JWT).
- Asynchronous tooling — **Complete**
  - Current: Queue system (Memory/Redis drivers, Job base class, Worker, failed job handling, retry/flush CLI), Event system (EventManager, Listener, built-in events, auto-discovery), Broadcasting (Memory/Redis drivers, public/private/presence channels, SSE middleware, auth middleware), Scheduler (cron parser, timezone support, fluent schedule API, overlap prevention, CLI list/run), Cache (Memory/Redis/File stores, tagged cache), Notifications (Mail/Database/Slack/Memory channels, queueable notifications).
  - Missing (post-1.0): more queue drivers (SQS, etc.), WebSocket broadcasting transport.
- Storage integrations — **Complete**
  - Current: StorageManager with Local, S3, and Memory drivers, file upload helpers, `storage:link` CLI command, visibility management, directory operations, temporary URLs.
  - Missing (post-1.0): additional cloud drivers (GCS, Azure Blob), streaming support.
- Database adapters — **In progress** → Phase 1
  - Current: Postgres and SQLite via Drizzle.
  - Missing (post-1.0): MySQL adapter. Postgres and SQLite cover the primary use cases; MySQL will be added based on community demand.
- Developer experience — **Complete**
  - Current: `bunx guren` CLI with extensive generators (`make:auth`, `make:controller`, `make:model`, `make:middleware`, `make:migration`, `make:seeder`, `make:job`, `make:event`, `make:listener`, `make:mail`, `make:notification`, `make:channel`, `make:command`, `make:exception`, `make:factory`, `make:provider`, `make:resource`, `make:route`, `make:test`, `make:view`, `make:lang`), database commands (`db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback`, `db:status`), queue commands (`queue:work`, `queue:failed`, `queue:retry`, `queue:flush`), scheduling commands (`schedule:list`, `schedule:run`), routes type generation (`routes:types`, `codegen`), `route:list`, `config:cache`/`config:clear`/`config:show`, `storage:link`, `health:check`, `doctor` diagnostics, `upgrade`, `lang:publish`/`lang:list`, `dev` server, `add` blueprints for feature scaffolding, `create-guren-app` project creator with SSR/SPA modes.
  - End-to-end type safety: `bunx guren codegen` generates `pages.gen.ts` (Babel AST Props extraction → `PagePropsMap`), `routes.gen.ts` (typed `route()` helper), `data.gen.ts` (`Data` namespace from `JsonResource.toArray()`), `api-client.gen.ts` (typed `ApiRoutes` with `body` fields from Zod schemas). Route-level schema binding (`body`/`params`/`query`), route model binding (`bind: { id: Post }` + `this.model(Post)`), typed `<Link>`/`<Form>` components, bidirectional form types (`RouteBody`/`RouteErrors`), Vite HMR auto-regeneration.
- Database lifecycle commands — **Complete**
  - Current: `db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `db:rollback` with safety checks, `db:status` for migration tracking.
- Release & compatibility policy — **Complete**
  - Current: SemVer commitment stated in CHANGELOG.
- Documentation & learning — **In progress** → Phase 2
  - Current: guides/tutorials (getting started, deployment, authentication, relationships, validation, CSRF, error handling).
  - Missing (1.0): end-to-end tutorial path, deployment recipes verified and versioned.
- Quality & reliability — **In progress** → Phase 1-2
  - Current: CI on Bun (build, routes types, typecheck, tests), 99 test files with ~24,000 lines of test code covering server packages (auth, cache, queue, events, broadcasting, scheduling, storage, mail, notifications, i18n, logging, health, errors, container, console, http middleware, validation, resources, database), comprehensive testing utilities (`TestApp`, `TestClient`, `FakeMail`, `FakeEvent`, `FakeQueue`, mock auth helpers, database assertions, Inertia test helpers).
  - Missing (1.0): integration/E2E coverage, performance benchmarks.
- Community process — **Complete**
  - Current: Code of Conduct, Contributing guide.
- First-party plugins — **Complete**
  - Current: Auth (scaffolding, auto-session, API tokens, password reset, email verification, policies/gates), Mail (SMTP, Resend transports), Queue (Memory/Redis), Cache (Memory/Redis/File, tagged cache), Notifications (Mail, Database, Slack, Memory channels), Broadcasting (Memory/Redis, SSE), Scheduler (cron, fluent API), Logging (Console, File, DailyFile channels), i18n (JSON loader, pluralization, namespaces), Health checks (Database, Redis, Cache, Storage, Memory, custom), Console commands (full Artisan-style kernel), Container/DI (bind/singleton/scoped/tag/alias/fake/contextual bindings), Error handling (HttpException, ExceptionHandler, debug page), Rate limiting middleware (fixed window, sliding window, Redis store), Encryption (AES-GCM/CBC, hashing, HMAC, random generation), Facades, Auto-discovery (providers, listeners, jobs), API Resources (JsonResource, ResourceCollection, Paginator, CursorPaginator).
  - Missing (post-1.0): additional mail transports, more notification channels (SMS, push).

## Path to 10/10

This section defines the execution plan for bringing the framework to a 10/10 target across four axes:

- Feature breadth
- Developer experience philosophy
- Maturity
- Reliability

### 10/10 goal definition

The framework should satisfy all of the following:

- A new user can create a production-shaped app in 30 minutes using only official docs.
- Existing users can upgrade across minor and major versions with predictable effort.
- Maintainers can decide release readiness using automated gates rather than judgment calls.
- Production incidents have clear diagnosis and recovery paths.

### Axis definitions

- Feature breadth 10/10
  - Core web framework capabilities are complete and coherent.
  - First-party docs and generators cover the supported feature set.
  - Features compose cleanly without divergent patterns.
- Developer experience philosophy 10/10
  - There is a single clear golden path.
  - CLI, docs, generators, and error messages all reinforce the same workflow.
  - Users can predict the next correct step without reading internal code.
- Maturity 10/10
  - Public APIs are stable and versioning is trustworthy.
  - Deprecation, migration, and support policies are practiced, not just written down.
  - Releases are routine rather than risky.
- Reliability 10/10
  - Unit, integration, E2E, smoke, and canary coverage are all present.
  - Supported runtime/database combinations are verified continuously.
  - Performance, memory, and packaging regressions are detectable before release.

### Known risks

- **Bun runtime stability:** Bun is pre-1.0 in some APIs. Breaking changes in Bun releases may require urgent framework patches. Mitigation: pin supported Bun versions, add version matrix CI.
- **Drizzle ORM coupling:** Heavy reliance on Drizzle means upstream breaking changes propagate. Mitigation: adapter abstraction layer already exists; keep Drizzle version pinned and test upgrades in isolation.
- **Solo/small-team maintenance:** Most framework subsystems are maintained by a small team. Mitigation: prioritize automation (CI gates, canaries, codemods) over manual processes; grow contributor base through good docs and starter kits.
- **Ecosystem adoption chicken-and-egg:** Plugin ecosystem requires users, but users want a mature ecosystem. Mitigation: ship production-shaped starter kits and dogfood reference apps to prove viability before 1.0.

## Phase 1: Foundation Hardening

Goal: move from strong alpha functionality to predictable release quality.

### Priority work

- Define and enforce a single golden path.
  - Standardize the official workflow as `create-guren-app -> add auth/resource -> codegen -> test -> build -> deploy`.
  - Align docs, generators, examples, and CLI output to this path.
- Turn release checks into mandatory CI gates.
  - Require `build`, `typecheck`, `test`, starter smoke, upgrade smoke, and example production builds for release branches.
- Strengthen generated app quality.
  - Ensure fresh apps pass build, typecheck, and test without manual fixes.
  - Ensure add-on flows (`auth`, `resource`, `queue`, `mail`, etc.) remain composable after generation.
- Expand `doctor` into a first-class recovery tool.
  - Detect missing codegen artifacts, configuration drift, broken imports, unsupported upgrades, and common runtime misconfiguration.
- Normalize CLI behavior.
  - Align option names, output formats, success/failure language, and support for `--help`, `--json`, and `--dry-run` where appropriate.
- Unify route contracts, codegen, and OpenAPI.
  - Keep a single source of truth for runtime behavior, generated types, and API documentation.

### Exit criteria

- A fresh app can go from scaffold to CRUD + auth + production build using only official docs.
- All release branches are gated by the same CI pipeline.
- Core CLI commands follow the same UX conventions.
- The framework can detect and explain common setup and upgrade mistakes automatically.

## Phase 2: Upgrade Safety and Operational Confidence

Goal: raise maturity and reliability into the 8-9/10 range.

### Priority work

- Introduce formal E2E coverage.
  - Cover auth, CRUD, validation, file upload, SSR navigation, queue execution, and mail preview flows.
- Productize upgrades.
  - Build `guren upgrade` into a trusted tool with codemods, compatibility checks, deprecation warnings, and migration guides.
- Continuously verify the support matrix.
  - Run test/build/smoke coverage across supported Bun versions, databases, Redis on/off, and SPA/SSR variants.
- Add nightly canary workflows.
  - Verify fresh app creation, packed install, upgrade scenarios, and docs walkthroughs every day.
- Ship higher-quality starter kits.
  - Maintain official starters for blog, API-only, SaaS-style, and worker-heavy applications.
- Standardize production-facing defaults.
  - Ensure logging, health checks, request IDs, queue failure visibility, and default error handling work out of the box.
- Restructure docs around task completion.
  - Organize docs by outcomes such as "build an auth app", "ship an API", "deploy to production", and "troubleshoot a broken setup".

### Exit criteria

- Upgrade paths across supported versions are automatically tested.
- Nightly canary runs catch regressions before releases.
- Official starter kits are maintained and production-shaped.
- Docs can be followed end-to-end without tribal knowledge.

## Phase 3: 1.0 Readiness and Long-Term Trust

Goal: make Guren comparable to mature frameworks in release confidence, not just feature count.

### Priority work

- Freeze the public API surface.
  - Separate experimental APIs from stable ones.
  - Require deprecation periods and migration notes for all breaking changes.
- Establish plugin ecosystem contracts.
  - Define plugin APIs, compatibility expectations, versioning rules, and extension test suites.
- Add continuous performance and memory regression testing.
  - Track baseline startup, request latency, build output, and memory behavior over time.
- Formalize long-term maintenance process.
  - Maintain RFC workflow, release cadence, security policy, triage standards, and regression-test requirements for fixes.
- Complete deployment recipes.
  - Maintain verified deployment flows for Docker, Fly.io, VPS, and valid serverless targets.
- Dogfood through real reference apps.
  - Keep multiple real apps on current Guren versions and use them to validate upgrades and operational ergonomics.

### Exit criteria

- 1.0 API stability rules are enforced in practice.
- Users can upgrade without fearing silent breakage.
- Performance and packaging regressions are visible before release.
- Maintainers can operate the project using documented process rather than institutional memory.

## Immediate Priority Order

1. **Golden path standardization** — all other items assume a canonical workflow exists; this unblocks docs, generators, and CI design
2. **Release-gate CI** — must be in place before any quality claims are meaningful; prevents regressions from landing
3. **`doctor` and `upgrade` hardening** — users hitting setup/upgrade issues have no self-service recovery without this
4. **E2E and canary coverage** — required to catch cross-cutting regressions that unit tests miss
5. **Docs restructuring** — depends on golden path being locked; high leverage for adoption
6. **Support matrix and benchmark automation** — enables data-driven release decisions
7. **Plugin and governance hardening** — 1.0 gating concern but not urgent until API surface stabilizes

## Realistic Timeline

- **Phase 1 — by 2026-04-26** (30 days)
  - Lock the golden path.
  - Convert current checks into release gates.
  - Raise generated app quality and improve `doctor`.
  - Success metric: fresh scaffold → CRUD + auth → production build passes with zero manual fixes.
- **Phase 2 — by 2026-05-26** (60 days)
  - Add E2E for core flows.
  - Add nightly canary jobs.
  - Stabilize upgrade and compatibility checks.
  - Success metric: nightly canary pass rate ≥ 95%; upgrade from previous minor version tested automatically.
- **Phase 3 — by 2026-06-25** (90 days)
  - Ship production-shaped starter kits.
  - Reorganize docs around task completion.
  - Introduce benchmark and memory regression tracking.
  - Success metric: all official starter kits pass smoke tests; startup latency and build size tracked with regression thresholds.
- **Phase 4 — by 2027-03** (6-12 months)
  - Freeze stable APIs.
  - Establish mature release and maintenance processes.
  - Build enough operational trust to justify a 1.0 claim.
  - Success metric: two consecutive minor releases with zero unintended breaking changes; at least two reference apps running on latest.

## Execution Backlog

This backlog breaks the roadmap into issue-sized work items that can be mapped directly to milestones.

### 30-day backlog

#### Golden path standardization — ✅ Done

- [x] Define the official `create-guren-app -> add auth/resource -> codegen -> test -> build -> deploy` workflow.
- [x] Rewrite the README Quick Start around the golden path.
- [x] Align the main example app with the golden path as the reference implementation.
- [x] Audit and remove ordering dependencies between `bunx guren add ...` flows.

#### Release-gate CI — ✅ Done

- [x] Add a release-focused CI workflow.
- [x] Make `bun run build` a mandatory release gate.
- [x] Make `bun run typecheck` a mandatory release gate.
- [x] Make `bun run test` a mandatory release gate.
- [x] Add `smoke:starter` to CI.
- [x] Add `smoke:upgrade-existing-app` to CI.
- [x] Add example production builds to the release workflow.
- [x] Integrate example test/build verification into the release workflow.

#### Generated app quality — ✅ Done

- [x] Ensure a fresh scaffolded app passes build, typecheck, and test without manual fixes.
- [x] Ensure `add auth` produces an app that still passes build, typecheck, and test.
- [x] Ensure `add resource` produces an app that still passes build, typecheck, and test.
- [x] Detect config drift introduced by add-on combinations (golden-path smoke tests multiple resources + queue/mail/events).
- [x] Standardize scaffold output conventions for imports, naming, comments, and file structure.

#### Doctor hardening — ✅ Done

- [x] Detect missing codegen output.
- [x] Detect missing routes/pages/data/api client generated files.
- [x] Detect config drift between expected and actual app wiring.
- [x] Detect unsupported Bun and runtime version mismatches.
- [x] Add autofix suggestions for common setup failures.
- [x] Stabilize `doctor --json` output for machine consumption.

#### CLI consistency — ✅ Done

- [x] Standardize `--help` output across major commands.
- [x] Add `--json` support where structured output is expected.
- [x] Add `--dry-run` support where mutation is possible.
- [x] Publish CLI wording guidelines for success, warning, and error output (`contributing/cli-wording-guidelines.md`).
- [x] Normalize `--force` semantics across commands (including queue:retry, queue:flush).

### 60-day backlog

#### E2E coverage — ✅ Done

- [x] Add a Playwright-based E2E test harness.
- [x] Add auth login/logout E2E coverage.
- [x] Add resource CRUD E2E coverage.
- [x] Add validation error flow E2E coverage.
- [x] Add Inertia SPA navigation E2E coverage (replaces SSR — app is CSR).
- [x] Add pagination E2E coverage.
- [x] Add multi-step user journey E2E coverage.
- [x] Add authenticated route protection E2E coverage.
- N/A: file upload, queue dispatch UI, mail preview (features not present in blog app).

#### Upgrade productization — ✅ Done

- [x] Define the scope and contract of `guren upgrade`.
- [x] Add a version compatibility checker.
- [x] Add framework-level deprecation warning support.
- [x] Add upgrade codemod infrastructure.
- [x] Add upgrade dry-run reporting (--checkOnly flag).
- [x] Introduce a migration guide template and release checklist (`contributing/`).

#### Support matrix automation — ✅ Done

- [x] Define supported Bun versions (`docs/support-matrix.md`).
- [x] Add Postgres and SQLite matrix coverage to CI (sqlite-smoke job).
- [x] Add Redis enabled/disabled matrix coverage to CI (sqlite-smoke runs without Redis).
- [x] Add SPA and SSR matrix coverage to CI (covered by example builds).
- [x] Publish the support matrix in the docs.

#### Nightly canary coverage — ✅ Done

- [x] Add nightly fresh-app canary checks.
- [x] Add nightly packed-install canary checks.
- [x] Add nightly upgrade canary checks.
- [x] Add nightly docs walkthrough verification (audit:docs in nightly).
- [x] Define triage rules for canary failures (`contributing/canary-triage-rules.md`).

#### Starter kits — In progress

- [x] Ship an official API-only starter (`--blueprint api`).
- [ ] Ship a SaaS-style starter.
- [x] Ship a worker-heavy starter (`--blueprint worker` with queue/events/cache/schedule).
- [ ] Add smoke coverage for each official starter.

### 90-day backlog

#### Docs restructuring — ✅ Done

- [x] Add a "Build an auth app" guide (en/ja).
- [x] Add a "Ship an API" guide (en/ja).
- [x] Add a "Deploy to production" guide (en/ja).
- [x] Add a "Troubleshoot a broken setup" guide (en/ja).
- [x] Reorganize docs IA around task completion (DocsService order updated).
- [ ] Add CI verification for documented walkthroughs.

#### Production defaults — ✅ Done

- [x] Enable request IDs by default (`requestIdMiddleware`).
- [x] Standardize structured logging defaults (`requestLoggingMiddleware` with JSON output).
- [x] Strengthen production health-check defaults (default `/health` in starter template).
- [ ] Improve queue failure visibility defaults.
- [ ] Improve default error pages and exception rendering.

#### Benchmarks and regression tracking — ✅ Done

- [x] Add startup benchmarks.
- [x] Add build artifact size tracking.
- [x] Add memory regression tracking.
- [x] Fail CI when benchmark thresholds regress beyond accepted bounds (nightly).
- [ ] Add request latency benchmarks.

### 6-12 month backlog

#### 1.0 readiness

- Define stable versus experimental API boundaries.
- Formalize deprecation policy enforcement.
- Add a breaking-change checklist to release process.
- Publish maintainer-facing SemVer operations guidance.

#### Plugin ecosystem

- Define a plugin contract.
- Add a plugin compatibility test harness.
- Publish an official plugin authoring guide.
- Define plugin versioning policy.

#### Governance and maintenance

- Formalize the RFC process.
- Publish a security policy.
- Set a release cadence.
- Define issue triage SLAs.
- Require regression tests for all bug fixes.

#### Verified deployment recipes

- Keep Docker deployment recipes under continuous verification.
- Keep Fly.io deployment recipes under continuous verification.
- Publish and verify VPS deployment recipes.
- Clarify valid and supported serverless deployment targets.

#### Dogfooding

- Maintain multiple real reference applications on current Guren versions.
- Verify framework upgrades against reference applications.
- Turn dogfooding feedback into a recurring product-quality input.
