---
name: dev-workflow
description: Development workflow commands for the Guren monorepo. Handles building packages, running tests (smart targeted or full suite), type checking, pre-PR validation, E2E tests, and dev server startup. Use when user says "build", "test", "typecheck", "type check", "run tests", "test my changes", "quick test", "pr check", "pre-PR", "ready for PR", "dev server", "start server", "e2e", "E2E", "end to end", "playwright".
---

# Development Workflow Skill

You are a development workflow assistant for the Guren framework monorepo.

## Your Role

Help users run builds, tests, type checks, and development servers with intelligent error diagnosis.

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

**On failure:** Identify the failing package and show the TypeScript/build error. The issue is usually in that package's `src/` directory.

### Test

Two modes: **smart** (targeted) and **full**.

#### Smart Test (default for "test my changes", "quick test")

1. Get changed files:
```bash
git diff --name-only HEAD
git diff --name-only --cached
```

2. Map to packages:
   - `packages/server/` → `bun test packages/server`
   - `packages/orm/` → `bun test packages/orm`
   - `packages/cli/` → `bun test packages/cli`
   - `packages/testing/` → `bun test packages/testing`
   - `examples/blog/` → `bun run test:examples`
   - `examples/api/` → `bun run test:examples`

3. Decision logic:
   - < 3 files in same package → run package tests
   - Multiple packages changed → run affected packages
   - > 10 files or cross-cutting → run full suite
   - No test impact detected → skip tests

4. After smart tests pass, remind: "Consider running full suite before PR: `bun run test`"

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

**On failure:** Identify the failing test file and test name, show the error, suggest fixes.

### Type Check

```bash
bun run typecheck
```

Runs root monorepo + blog example type checks.

**On failure:** List each error with file:line, show the message, suggest fixes for common issues (missing types, incorrect imports, type mismatches).

### Lint

```bash
bun run lint
```

oxlint with the type-aware rules (`typescript/no-floating-promises`) plus the repo's own `guren/await-async-assertion`. Warnings fail the run too. `bun run lint:fix` applies the safe auto-fixes.

**On failure:** Show each finding with file:line and the rule name. A `no-floating-promises` finding on a call whose result is dropped on purpose takes a `void` in front; an un-awaited `expect(...).rejects` / `.resolves` takes `await`.

### PR Check (pre-PR validation)

Run all checks in order. **Stop and report on first failure:**

```bash
bun run build && bun run typecheck && bun run lint && bun run test
```

On success, confirm:
- All packages built successfully
- No type errors found
- All tests passing

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
