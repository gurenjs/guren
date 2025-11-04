# Guren Framework

Guren is a Laravel-inspired fullstack framework for TypeScript that runs on Bun. It pairs a familiar MVC developer experience with modern tooling such as the Hono HTTP server, Inertia.js + React for the frontend, and Drizzle ORM for database access. The framework ships as a monorepo with reusable packages and example applications.

## Features

- Bun-native runtime that boots a Hono server with minimal overhead
- Laravel-style routing, controllers, and Eloquent-inspired model API
- Inertia.js + React pages for SPA-like UX without maintaining a separate frontend app
- Drizzle ORM integration with adapter pattern for swapping database backends
- Batteries-included CLI with scaffolding, dev tooling, and route typing helpers

## Project Status

Guren is currently considered **alpha** software. Expect rapid iteration and potentially breaking changes while the roadmap is completed. Feedback and early adopters are encouraged.

## Architecture Overview

- **Runtime:** Bun (v1.1+) executes the Hono-powered HTTP server.
- **Routing:** `Route` registry offers Laravel-style DSL (`Route.get`, `Route.group`, etc.) mounted during application boot.
- **Controllers:** Extend the base `Controller` class to gain helpers such as `this.inertia()`, `this.json()`, and request context access.
- **Views:** React components in `resources/js/pages/` are rendered via Inertia.js, with Vite powering assets.
- **ORM:** Models extend `Model<TRecord>` and delegate to the configured `ORMAdapter`. Drizzle is wired through the default `DrizzleAdapter`.
- **CLI:** Toolkit lives under `packages/cli` and centralizes runtime commands in `runtime.ts` while generators reside alongside scaffolding utilities.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.1.0 or newer (`bun --version`)
- Docker (for running the bundled PostgreSQL instance)

### Installation

1. Install dependencies:
   ```bash
   bun install
   ```
2. Start the Postgres container (runs on port 54322 by default):
   ```bash
   bun run db:up
   ```
3. Boot the development server:
   ```bash
   bun run dev
   ```
4. Visit the URL printed by the dev server (typically `http://localhost:3000`).

To stop the database container, run `bun run db:down`. Logs are available via `bun run db:logs`.

### Workspace Scripts

- `bun run build` – build every package (routes types, testing utilities, ORM, server, CLI, core, inertia client)
- `bun run dev` – start the demo application in development mode
- `bun run db:migrate` / `bun run db:seed` – execute migrations or seeders for the demo application

### Production Builds

When preparing the blog example (or any Guren app) for production, build both the client and SSR bundles so the server can stream pre-rendered HTML:

```bash
cd examples/blog
bunx vite build && bunx vite build --ssr
```

`src/main.ts` reads the generated manifest files to populate `GUREN_INERTIA_ENTRY`, `GUREN_INERTIA_STYLES`, and `GUREN_INERTIA_SSR_ENTRY`, enabling Inertia's server-side rendering path by default.

## Project Structure

- `packages/core/` – framework runtime, routing, controllers, middleware
- `packages/server/` – server bootstrap helpers around Hono
- `packages/orm/` – ORM adapter abstraction and Drizzle integration
- `packages/cli/` – CLI commands, scaffolding, and route type generation
- `packages/inertia-client/` – frontend integration utilities
- `packages/testing/` – shared testing helpers
- `examples/` – reference applications demonstrating framework usage
- `app/`, `config/`, `resources/` – application skeleton used by the examples and generators

## Development Workflow

1. Import route files as side-effects in `src/main.ts`, instantiate the `Application`, register providers (e.g., `DatabaseProvider`), then call `app.boot()` followed by `app.listen()`.
2. Use the `bunx guren` CLI for scaffolding and tooling:
   ```bash
   bunx guren make:controller UserController
   bunx guren make:model User
   bunx guren make:view users/Index
   bunx guren make:auth --force
   bunx guren routes:types --routes routes/web.ts --out types/generated/routes.d.ts
   bunx guren dev
   ```
3. Configure the ORM via `DatabaseProvider`, which wires the `DrizzleAdapter`, runs migrations, and seeds data using `configureOrm()`.

## Database

- Docker Compose service name: `postgres`
- Connection string: `postgres://guren:guren@localhost:54322/guren`
- Credentials: user `guren`, password `guren`, database `guren`
- Schema definitions live in `db/schema.ts` and are consumed by models through the static `table` property.

## Roadmap

- [ ] Routing parity with resource routes, named routes, scoped groups, and implicit model binding
- [ ] Framework-level validation pipeline and reusable middleware library
- [ ] Expanded ORM features: relationships, eager loading, scopes, soft deletes, and observers
- [ ] Comprehensive auth/authorization suite with OAuth providers, password reset, API tokens, and policies
- [ ] Asynchronous tooling: queues, events, broadcasting, scheduler, and cache abstractions
- [ ] Storage integrations: first-party drivers for Amazon S3, Cloudflare D1, and pluggable abstractions
- [ ] Database adapters: first-party MySQL and SQLite support alongside Postgres
- [ ] Developer experience improvements: finalized CLI scaffolding, artisan-style utilities, and richer testing helpers
- [ ] Database lifecycle commands: first-party `guren db:reset` / `guren db:rollback` with safe Postgres helpers and guardrails

## Contributing

Issues, discussions, and pull requests are welcome. Please review the [contributing guide](./CONTRIBUTING.md) for environment setup, testing instructions, and our preferred workflow. Run `bun run test` and `bun run build` before opening a pull request.

## License

Released under the [MIT License](./LICENSE).
