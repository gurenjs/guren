---
name: guren-new-app
description: Scaffold a new Guren application (Bun + Hono + Drizzle + Inertia, Laravel-shaped) in a directory that has no Guren app yet, and hand off to the app's own agent harness. Use when the user wants to start a Guren project, says "new Guren app", "create a Guren project", "scaffold Guren", or asks what Guren is before choosing a stack. For a directory that already has a Guren app, use guren-harness instead.
---

# New Guren App

You are helping someone start a Guren application from nothing. This skill
ends where the app's own harness begins — once the app exists, its
`CLAUDE.md` / `AGENTS.md` and rules directory are authoritative, not this
file.

## What Guren is, in one paragraph

Guren is a Laravel-inspired fullstack TypeScript framework on Bun. Hono
handles HTTP, Drizzle is the ORM, Inertia.js + React is the frontend, and
Zod validates input. Expect Laravel's shapes: `app/Http/Controllers/`,
`app/Models/`, `routes/web.ts`, `db/schema.ts`, `resources/js/pages/`.
Controllers extend `Controller` and call `this.validateBody(schema)`,
`this.inertia(pages.posts.Index, props)`, `this.redirect('/posts')`. Models
come from `defineModel(table)`. Routes are `router.get('/posts', [PostController, 'index'])`.

What makes it different for an agent: the framework ships introspection and
integrity commands you can run instead of guessing — `guren context` (project
map + API signature digest), `guren check` (route ↔ controller ↔ page
consistency, doc links, spec freshness), `guren audit` (validation and auth
on mutating routes, raw SQL, secrets), and `guren gate` (every CI stage in one
exit code: codegen, typecheck, lint, check, audit, tests). Those live in the
app's `@guren/cli` dependency, so they exist only once an app does.

## Before you run anything

Confirm there is no Guren app here: no `package.json` with a `@guren/core`
dependency in this directory or a parent. If there is one, stop and use the
`guren-harness` skill instead.

**Do not run `bunx guren …` before the app exists.** The `guren` package is
not on npm; `bunx guren` resolves only through an app's local `@guren/cli`.
Outside an app it fails, and outside an app there is nothing for it to
introspect anyway.

## Scaffold

```bash
bunx create-guren-app <name>
```

Read `bunx create-guren-app --help` for the current options rather than
relying on this file — it is the scaffolder's own contract and it changes
independently of this skill. It will ask about the starter blueprint, the
database, and which AI agents to set the harness up for; answer the last one
with every agent the team uses, so the harness is installed as part of
scaffolding rather than as a forgotten follow-up.

## Check the postcondition, do not assume it

`create-guren-app` exits 0 even when dependency installation fails: it warns,
skips the harness step, and tells you to run `bunx guren agent:init` later.
So after it returns, verify inside the new directory:

1. `node_modules/@guren/cli` exists. If not, run `bun install`.
2. An entry document exists — `CLAUDE.md` or `AGENTS.md`. If not, run
   `bunx guren agent:init --target <agents>` (see `guren-harness`).

Only then is `bunx guren …` safe to run.

## Hand off

From here, work inside the app and follow its harness:

- Read the app's `CLAUDE.md` or `AGENTS.md` first.
- Run `bunx guren context` at session start and read the API signature digest
  at the end of its output before writing code.
- After editing routes, controllers, models, `db/schema.ts`, or pages, run
  `bunx guren check` and fix what it reports.
- When the change is complete, run `bunx guren gate` and fix what it reports
  until it exits 0.

This skill has nothing further to add once the app is scaffolded.
