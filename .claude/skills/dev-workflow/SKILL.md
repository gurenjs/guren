---
name: dev-workflow
description: Development workflow commands for the Guren monorepo. Handles building packages, running tests (smart targeted or full suite), type checking, pre-PR validation, and dev server startup. Use when user says "build", "test", "typecheck", "type check", "run tests", "test my changes", "quick test", "pr check", "pre-PR", "ready for PR", "dev server", "start server".
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

Build order: testing → orm → server → cli → core → create-app → inertia-client

**Single package:**
```bash
bun run build:server  # @guren/server
bun run build:orm     # @guren/orm
bun run build:cli     # @guren/cli
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
- `bun run test:bun` — Framework tests (packages/server, packages/orm, packages/cli, etc.)
- `bun run test:examples` — Example app tests (blog, api)

**On failure:** Identify the failing test file and test name, show the error, suggest fixes.

### Type Check

```bash
bun run typecheck
```

Runs root monorepo + blog example type checks.

**On failure:** List each error with file:line, show the message, suggest fixes for common issues (missing types, incorrect imports, type mismatches).

### PR Check (pre-PR validation)

Run all checks in order. **Stop and report on first failure:**

```bash
bun run build && bun run typecheck && bun run test
```

On success, confirm:
- All packages built successfully
- No type errors found
- All tests passing

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
