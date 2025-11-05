# Guren Documentation Overview

Guren is a Bun-native TypeScript MVC framework that unites Laravel-like ergonomics with Hono, Inertia.js, React, and Drizzle ORM, aiming to deliver a fast, elegant full-stack workflow that keeps frontend and backend work in sync. The name “Guren” (紅蓮), meaning “crimson lotus,” reflects the framework’s blend of intensity and refinement.

## Why Guren?
- **Fast inner loop**: Bun’s native tooling and Hono’s lightweight server deliver quick feedback during development.
- **Laravel-like ergonomics**: The `Route` DSL, `Controller`/`Model` base classes, and Inertia-powered views feel familiar and productive.
- **Type-safe data access**: Drizzle ORM offers an Eloquent-style API with rich TypeScript types.
- **All-in-one scaffold**: `create-guren-app` generates backend, frontend, and database wiring so you can start coding immediately.

## Quick Start
1. Scaffold a project (choose SSR or SPA when prompted, or force with `--mode ssr|spa`): `bunx create-guren-app my-app`
2. Change into the directory: `cd my-app`
3. Install dependencies: `bun install`
4. Start the dev server (Bun + Vite auto-launch together): `bun run dev` and visit `http://localhost:3333`

Need more detail? Head to [Getting Started](./getting-started.md) for database setup and environment configuration.

## Documentation Map
- [Getting Started](./getting-started.md): Prerequisites, environment setup, development and build workflow.
- [Architecture](./architecture.md): MVC structure, routing, models, and Inertia integration.
- [CLI Reference](./cli.md): How to use the `guren` CLI and its primary commands.
- [Controller Guide](./controllers.md): Authoring controllers, handling requests, and wiring routes.
- [Routing Guide](./routing.md): Declaring routes, groups, middleware, and inline handlers.
- [Database Guide](./database.md): Working with Drizzle schemas, migrations, and seeders.
- [Authentication Guide](./authentication.md): Configuring guards, user providers, and route protection.
- [Frontend Guide](./frontend.md): Building Inertia-powered React pages and managing assets.
- [Deployment Guide](./deployment.md): Preparing, building, and running your app in production.
- [Testing Guide](./testing.md): Running Bun package suites and Vitest-powered example tests.

## Terminology
- **Application (`my-app` etc.)**: A project scaffolded with `create-guren-app`; this is your main workspace.
- **Bootstrap**: The initialization flow in `src/main.ts` that registers routes, configures the ORM, and boots the `Application` instance.

Have suggestions or discover issues? Open an issue or submit a PR—we appreciate the feedback!
