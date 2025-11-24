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

### Quick Start

Create a new Guren application with optional authentication (auth scaffolding auto-runs when `--auth` is passed):

```bash
bunx create-guren-app my-app --auth
cd my-app
bun install
bunx guren make:auth --install  # already attempted when --auth is passed
bun run db:migrate
bun run db:seed
bun run dev
```

Visit `http://localhost:3000` to see your application running!

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
   bunx guren make:auth --install  # scaffold auth with auto-wiring (already attempted when --auth)
   bunx guren routes:types --routes routes/web.ts --out types/generated/routes.d.ts
   bunx guren dev
   ```
3. Configure the ORM via `DatabaseProvider`, which wires the `DrizzleAdapter`, runs migrations, and seeds data using `configureOrm()`.

### Authentication

Guren provides built-in authentication scaffolding with automatic configuration:

```bash
bunx guren make:auth --install
```

This command scaffolds:
- **Controllers:** `LoginController` for authentication and `DashboardController` for protected routes
- **Models:** `User` model extending `AuthenticatableModel` with password hashing support
- **Providers:** `AuthProvider` using the `auth.useModel()` shorthand API
- **Validators:** `LoginValidator` with Zod schema validation
- **Views:** Login page and dashboard with React/Inertia.js
- **Database:** Migration for users table and seeder for demo user
- **Routes:** Auth routes (`/login`, `/logout`, `/dashboard`)

#### What `--install` Does

The `--install` flag automatically wires everything up:
- ✅ Registers `AuthProvider` in your `Application` providers array
- ✅ Adds session middleware with defaults (`cookieSecure` is `true` in production, `false` in dev)
- ✅ Imports auth routes into `routes/web.ts`
- ✅ Safe and idempotent - won't duplicate existing configuration

#### Manual Setup (without `--install`)

If you prefer to configure manually or already have partial setup:

```bash
bunx guren make:auth  # scaffold files only
```

Then manually add to your `src/app.ts`:

```typescript
import { Application, createSessionMiddleware } from '@guren/server'
import AuthProvider from '../app/Providers/AuthProvider.js'

const app = new Application({
  providers: [AuthProvider],
})

app.use('*', createSessionMiddleware({ cookieSecure: false }))
```

And import routes in `routes/web.ts`:

```typescript
import './auth.js'
```

#### After Scaffolding

Run migrations and seed the database:
```bash
bun run db:migrate
bun run db:seed
```

Visit `/login` to sign in with the demo user:
- **Email:** `demo@example.com`
- **Password:** `secret`

#### Using `auth.useModel()` Shorthand

The generated `AuthProvider` uses a simplified API:

```typescript
export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }
}
```

This single method call:
- Registers a `ModelUserProvider` with the specified columns
- Creates a `SessionGuard` with proper session handling
- Sets up the default guard as 'web'
- Uses `ScryptHasher` for password hashing by default

For advanced use cases, you can still manually configure providers and guards.

## CLI Reference

Guren provides a comprehensive CLI for scaffolding and development:

### Project Creation

```bash
# Create a new Guren application
bunx create-guren-app my-app

# Create with SSR mode (default)
bunx create-guren-app my-app --mode ssr

# Create with SPA mode
bunx create-guren-app my-app --mode spa

# Create with authentication scaffolding prompt
bunx create-guren-app my-app --auth

# Force overwrite existing directory
bunx create-guren-app my-app --force
```

### Scaffolding Commands

```bash
# Generate a controller
bunx guren make:controller PostController

# Generate a model
bunx guren make:model Post

# Generate a view component
bunx guren make:view posts/Index

# Generate a test file
bunx guren make:test PostTest --runner bun

# Generate a route group
bunx guren make:route api

# Generate authentication scaffolding
bunx guren make:auth --install

# Generate a migration
bunx guren make:migration create_posts_table
```

### Database Commands

```bash
# Run pending migrations
bunx guren db:migrate

# Seed the database
bunx guren db:seed
```

### Development Commands

```bash
# Start development server
bunx guren dev

# Generate TypeScript route declarations
bunx guren routes:types --routes routes/web.ts --out types/generated/routes.d.ts

# Open REPL console
bunx guren console
```

### Flags

- `--force` / `-f`: Overwrite existing files
- `--install` / `-i`: Auto-wire configuration (for `make:auth`)

## Database

- Docker Compose service name: `postgres`
- Connection string: `postgres://guren:guren@localhost:54322/guren`
- Credentials: user `guren`, password `guren`, database `guren`
- Schema definitions live in `db/schema.ts` and are consumed by models through the static `table` property.

## Roadmap

Status details live in `ROADMAP.md`.

- [ ] Routing parity with resource routes, named routes, scoped groups, and implicit model binding
- [ ] Framework-level validation pipeline and reusable middleware library
- [ ] Expanded ORM features: relationships, eager loading, scopes, soft deletes, and observers
- [ ] Comprehensive auth/authorization suite with OAuth providers, password reset, API tokens, and policies
- [ ] Asynchronous tooling: queues, events, broadcasting, scheduler, and cache abstractions
- [ ] Storage integrations: first-party drivers for Amazon S3, Cloudflare D1, and pluggable abstractions
- [ ] Database adapters: first-party MySQL and SQLite support alongside Postgres
- [ ] Developer experience improvements: finalized CLI scaffolding, artisan-style utilities, and richer testing helpers
- [ ] Database lifecycle commands: first-party `guren db:reset` / `guren db:rollback` with safe Postgres helpers and guardrails
- [ ] Release and compatibility policy: SemVer guarantees, Bun/Node compatibility matrix, and migration guides per minor release
- [ ] Documentation and learning: opinionated quickstart, end-to-end tutorial, deployment recipes (Docker/Edge/Serverless), and troubleshooting docs
- [ ] Quality and reliability: CI with Bun runners, integration/E2E coverage (routes, Inertia SSR, ORM), perf/footprint benchmarks, and nightly canary builds
- [ ] Community process: contribution templates, RFC workflow for breaking changes, and regular changelog/release notes
- [ ] First-party plugins: auth scaffolding refinements, mail/queue/cache drivers, job scheduler, and adapter examples beyond Postgres/Drizzle

## Contributing

Issues, discussions, and pull requests are welcome. Please review the [contributing guide](./CONTRIBUTING.md) for environment setup, testing instructions, and our preferred workflow. Run `bun run test` and `bun run build` before opening a pull request.

## License

Released under the [MIT License](./LICENSE).
