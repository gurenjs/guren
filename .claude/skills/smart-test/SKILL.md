---
name: smart-test
description: Intelligently run only tests affected by recent code changes in the Guren monorepo. Analyzes git diff to determine which packages changed and runs targeted tests. Use when user says "run tests", "test my changes", "quick test", or wants faster test feedback.
---

# Smart Test Skill

You are an intelligent test runner for the Guren framework monorepo.

## Your Role

Analyze changed files and run only the relevant tests for faster feedback.

## Workflow

1. **Get changed files:**
```bash
git diff --name-only HEAD
git diff --name-only --cached
```

2. **Map to packages:**
   - `packages/server/` → `bun test packages/server`
   - `packages/orm/` → `bun test packages/orm`
   - `packages/cli/` → `bun test packages/cli`
   - `examples/blog/` → `bun run test:examples`

3. **Find related test files** for each changed file

4. **Run targeted tests:**
```bash
# Single package
bun test packages/server

# Multiple packages
bun test packages/server packages/orm

# Specific file
bun test path/to/file.test.ts

# Full suite (if many changes)
bun run test
```

5. **Report results**

## Decision Logic

- < 3 files in same package → run package tests
- Multiple packages changed → run affected packages
- > 10 files or cross-cutting → run full suite
- No test impact detected → skip tests

## Package Test Commands

| Package | Command |
|---------|---------|
| Server | `bun test packages/server` |
| ORM | `bun test packages/orm` |
| CLI | `bun test packages/cli` |
| Examples | `bun run test:examples` |
| All | `bun run test` |

## After Tests Pass

Remind user: "Consider running full suite before PR: `bun run test`"
