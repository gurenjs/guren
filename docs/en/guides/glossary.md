# Glossary

Short definitions for common terms in the Guren docs.

## Stack
- **Bun**: JavaScript/TypeScript runtime used to run and build the app.
- **Hono**: Lightweight HTTP server; Guren builds its routing and controllers on top.
- **Inertia.js**: Bridges server responses and SPA navigation by sending page props.
- **React**: UI library used for pages.
- **Vite**: Frontend dev server and build tool.
- **Drizzle ORM**: Type-safe ORM; Guren models connect to Drizzle schemas.

## App structure
- **MVC**: Model, View, Controller separation.
- **Route**: A path + HTTP method mapping to a controller or handler.
- **Controller**: Class that handles requests and returns responses.
- **Model**: Class tied to a database table via `static table`.
- **View**: React page in `resources/js/pages/`.
- **Middleware**: Code that runs before or after a request.
- **Provider**: Boot-time registration for services and configuration.
- **Context**: Hono `Context` with request and response helpers.

## Database
- **ORM**: Maps tables to classes.
- **Schema**: Table definitions in `db/schema.ts`.
- **Migration**: SQL files that apply schema changes.
- **Seeder**: Script to insert sample data.
- **Database URL**: Connection string in `.env` as `DATABASE_URL`.
- **RQB (Relational Query Builder)**: Drizzle query builder for joins and aggregates.
- **Eager load**: Fetch related records in one go (e.g. `with()`).

## Frontend
- **SPA**: Single page app navigation without full reloads.
- **SSR**: Server-side rendering for the first HTML response.
- **Props**: Data passed to React components.
- **HMR**: Hot reload of frontend changes during development, handled by Vite. Backend changes (controllers, routes, models) reload too, since the dev server runs under `bun --hot`.
- **Inertia page**: A React component referenced by `this.inertia(...)`.

## CLI
- **create-guren-app**: CLI to scaffold a new app.
- **guren CLI**: `bunx guren make:*` commands for generators and tooling.

## Agent harness
- **Agent harness**: the files `create-guren-app` installs for coding agents: what an agent reads first, what runs after it edits, and what runs before it ends a turn.
- **CLAUDE.md**: the project guide Claude Code reads at the start of a session. [Claude Code docs](https://code.claude.com/docs/en/memory)
- **Rules**: instructions in `.claude/rules/`, loaded only when the agent edits a file their `paths` match. [Claude Code docs](https://code.claude.com/docs/en/memory#path-specific-rules)
- **Skills**: procedures the agent follows for a kind of task, in `.claude/skills/<name>/SKILL.md`. [Claude Code docs](https://code.claude.com/docs/en/skills)
- **Subagents**: agents with their own instructions and context that the main agent invokes, in `.claude/agents/`. [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- **Hooks**: commands Claude Code runs at points such as session start, a file edit, or the end of a turn, configured in `.claude/settings.json`. [Claude Code docs](https://code.claude.com/docs/en/hooks)
- **Gate (`guren gate`)**: runs codegen, typecheck, lint, `check`, `audit` and the tests in one command. CI and the `Stop` hook run the same one.

## Plan states
`plan:status`, `plan:verify` and `plan:next` print these values for steps and elements. See [Implementation Plans](./implementation-plans.md) for the details.
- **`verified`**: every verify command passed, and the record still holds.
- **`failed`**: a verify command failed; there is something to fix.
- **`blocked`**: the environment kept a command from running (a missing script, an unreachable database, a timeout). Not a failed implementation.
- **`drifted`**: a file the record fingerprinted changed after it verified. Re-check it with `plan:verify --step`.
- **`stalled`**: the `Stop` hook sent the agent back and the step still did not verify, so it recorded why and let the stop through. The next `plan:next` reports it.
- **`held`**: something the step depends on changed in the app after approval, so `plan:next` holds the step.
- **`waived`**: accepted incomplete with `plan:waive`.
- **advisory**: a result that is shown but never fails `--ci` or `guren gate`.

## Start here
- [First Steps](./first-steps.md)
- [Getting Started](./getting-started.md)
