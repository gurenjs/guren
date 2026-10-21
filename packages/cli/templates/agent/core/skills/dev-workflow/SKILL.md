---
name: dev-workflow
description: Run the dev server, build, tests, typecheck and pre-PR checks, and look up the MCP endpoint and its tools. Database work is db-manage.
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
1. Database running? Container-backed projects start it with `bun run db:up`; SQLite needs nothing.
2. Migrations applied? If not: `bun run db:migrate`

**After startup:**
- App: `http://localhost:3333`
- MCP endpoint: see MCP Server below

### MCP Server

`bun run dev` starts an MCP endpoint alongside the dev server (enabled by
`GUREN_MCP=1` in the `dev` script; if your script lacks it, run
`GUREN_MCP=1 bun run dev`; the flag has no effect in production):

```
http://localhost:3333/_guren/mcp
```

`bunx guren agent:init` writes the MCP client config for the agents you
selected: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor),
`.vscode/mcp.json` (VS Code / Copilot), `.codex/config.toml` (Codex — a
project-scoped config Codex reads in trusted projects only), or the `mcp`
entry in `opencode.json` (OpenCode). If your agent is not configured yet,
point it at the URL above as a streamable-HTTP server.

The endpoint only accepts requests from this machine: browser pages on other
origins (including DNS rebinding) and requests from other hosts on the LAN
are rejected with 403.

#### Available tools

| Tool | Description |
|------|-------------|
| `guren_get_context` | Project structure map (models, routes, pages, controllers, …) |
| `guren_entity_context` | Entity-centric context bundle (model, routes, pages, linked docs) |
| `guren_check` | Validate route ↔ controller ↔ page consistency, doc links, spec freshness |
| `guren_gate` | Every CI stage (codegen, typecheck, lint, check, audit, test) in one verdict; `ok` = the change is done |
| `guren_docs_graph` | OKF docs relation graph (narrow with entity/path) — impact query before renames |
| `guren_agent_surface` | Routes an autonomous agent can already call (`.agent()` tools) — check before editing one |
| `guren_get_application_graph` | Routes, controllers, models and pages with their relationships, coverage and evidence |
| `guren_get_runtime_errors` | Server errors the running dev app retained: status, route, project stack frames |
| `guren_get_plans` | Implementation plans not closed yet, drafts included: approval, step outcomes, the active step, the next command |
| `guren_list_models` | List models (relations, soft deletes, auth trait) |
| `guren_generate_guidelines` | Generate project-specific coding guidelines |
| `guren_doctor` | Project health check + suggested next actions |
| `guren_make_feature` | Scaffold a complete CRUD feature |
| `guren_make_component` | Scaffold a single component |
| `guren_codegen` | Generate typed manifests (routes.gen.ts, pages.gen.ts, …) |

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
