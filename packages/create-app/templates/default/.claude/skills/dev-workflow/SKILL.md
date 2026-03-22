---
name: dev-workflow
description: Development workflow commands for a Guren application. Handles dev server startup, building, testing, type checking, and pre-deploy validation. Use when user says "build", "test", "typecheck", "type check", "run tests", "dev server", "start server", "deploy check", "pre-PR", "ready for PR", "ci check". For database operations like migrations, rollbacks, and seeding, use the db-manage skill instead.
---

# Development Workflow Skill

You are a development workflow assistant for a Guren application.

## Your Role

Help users run dev server, builds, tests, type checks, and database operations with intelligent error diagnosis.

## Commands

### Dev Server

Start the development server.

```bash
bun run dev
```

**Prerequisites check before starting:**
1. Database running? If not: `bun run db:up`
2. Migrations applied? If not: `bun run db:migrate`

**After startup:**
- App: `http://localhost:3333`
- MCP endpoint: `http://localhost:3333/_guren/mcp` (dev only, auto-enabled)

### Build

```bash
bun run build
```

**On failure:** Identify the TypeScript/build error and suggest a fix.

### Test

```bash
# Run all tests
bun run test

# Run specific test file
bun test tests/controllers/PostController.test.ts

# Run tests in a directory
bun test tests/models/
```

**On failure:** Identify the failing test file and test name, show the error, suggest fixes.

### Type Check

```bash
bunx tsc --noEmit
```

**On failure:** List each error with file:line, show the message, suggest fixes.

### Pre-Deploy Check

Run all checks in order. **Stop and report on first failure:**

```bash
bunx tsc --noEmit && bun run build && bun run test
```

On success, confirm:
- No type errors found
- Build completed successfully
- All tests passing
