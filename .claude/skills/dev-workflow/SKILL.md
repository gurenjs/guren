---
name: dev-workflow
description: Development workflow commands for the Guren monorepo. Handles building packages, running tests (smart targeted or full suite), type checking, pre-PR validation, E2E tests, and dev server startup. Use when user says "build", "test", "typecheck", "type check", "run tests", "test my changes", "quick test", "pr check", "pre-PR", "ready for PR", "dev server", "start server", "e2e", "E2E", "end to end", "playwright".
---

# Development Workflow Skill

When one of these commands fails on something your change caused, fix it and
run the command again. Report without fixing only a failure that was there
before the change, or one that needs a decision from the user.

## Commands

### Build

Build all packages in the correct dependency order.

```bash
bun run build
```

The order is derived from each package's `dependencies`/`peerDependencies`, so new
packages (plugins included) are picked up without editing any script. Print it with:

```bash
bun run build:list
```

**Single package:**
```bash
bun run build server  # @guren/server
bun run build orm     # @guren/orm
bun run build cli     # @guren/cli
```

A DTS failure that cannot find a sibling's declaration file is usually a stale
`dist/`: run `bun run build:clean`, and use it after switching branches or
pulling large changes.

### Test

Two modes: **smart** (targeted) and **full**.

#### Smart Test (default for "test my changes", "quick test")

Run the tests of the packages the change touches (`git diff --name-only HEAD`,
plus untracked files), and of the packages that load them: a change to
`packages/server` reaches `packages/cli` tests through `dist/`, so rebuild
first. A change under `examples/` runs `bun run test:examples`. A change that
cuts across packages, or to a script or config every package shares, runs the
full suite. Say in the report that the full suite has not run.

```bash
bun run test:bun server cli   # one or more packages
```

#### Full Test Suite (default for "run tests", "test")

```bash
bun run test
```

Runs:
- `bun run test:bun` — Framework tests. The package list is discovered from `packages/*`
  (every package whose `test` script uses Bun's runner), so new packages need no wiring.
  `bun run test:bun:list` prints it; `bun run test:bun <pkg>` narrows it.
- `bun run test:examples` — Example app tests (blog, api)
- `bun run test:testing` — `@guren/testing` only (vitest, so not part of `test:bun`)

A test that fails only when run with the whole suite and passes alone is not a
verdict on the change: re-run its file alone before reading the assertion.

### Type Check

```bash
bun run typecheck
```

Runs root monorepo + blog example type checks.

### Lint

```bash
bun run lint
```

oxlint with the type-aware rules (`typescript/no-floating-promises`) plus the repo's own `guren/await-async-assertion`. Warnings fail the run too. `bun run lint:fix` applies the safe auto-fixes.

**On failure:** Show each finding with file:line and the rule name. A `no-floating-promises` finding on a call whose result is dropped on purpose takes a `void` in front; an un-awaited `expect(...).rejects` / `.resolves` takes `await`.

### PR Check (pre-PR validation)

The list is "Before Opening PRs" in `CLAUDE.md`; this is its always-run part:

```bash
bun run build && bun run typecheck && bun run lint && bun run test
bun run audit:core-first && bun run audit:docs
```

`bun run audit:prose` when `docs/` changed. When `packages/create-app/templates/`
or `packages/cli/templates/` changed, also `bun run audit:starter-template` and
the starter smokes that section names. Report which of these ran and which did
not.

### E2E Tests (default for "e2e", "playwright", "end to end")

Runs Playwright E2E tests against the blog example app.

**Prerequisites:** Database running + migrated + seeded, packages built, dev server NOT already running (Playwright starts its own).

```bash
cd examples/blog && bun run e2e
```

Opens Playwright UI for debugging:
```bash
cd examples/blog && bun run e2e:ui
```

**Known flaky tests:**
- Validation tests (Inertia XHR round-trip timing) are flaky in CI. They are skipped via `test.skip(!!process.env.CI)` but may occasionally fail locally too. If only validation tests fail, it is safe to proceed.

**On failure:**
1. Check if the failure is a known flaky test (validation spec)
2. If not, check the error screenshot in `examples/blog/test-results/`
3. Ensure the database is running and seeded: `bun run db:up && bun run db:migrate && bun run db:seed`

### Dev Server

Start the blog example development server.

```bash
bun run dev
```

Available at http://localhost:3333

**Prerequisites check before starting:**
1. Database running? If not: `bun run db:up`
2. Migrations applied? If not: `bun run db:migrate`
3. Packages built? If not: `bun run build`

## Package Test Commands

| Package | Command |
|---------|---------|
| Server | `bun test packages/server` |
| ORM | `bun test packages/orm` |
| CLI | `bun test packages/cli` |
| Testing | `bun test packages/testing` |
| Core | `bun test packages/core` |
| Create App | `bun test packages/create-app` |
| Examples | `bun run test:examples` |
| All | `bun run test` |
