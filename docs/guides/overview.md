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

## Guided Path
Follow this order if you’re new to Guren—the topics build on each other from scaffolding through production:

1. **[Getting Started](./getting-started.md)** — Prerequisites, environment setup, development workflow.
2. **[Architecture](./architecture.md)** — How the MVC layers, providers, and runtime fit together.
3. **[Routing Guide](./routing.md)** — Defining HTTP routes, groups, and middleware.
4. **[Controller Guide](./controllers.md)** — Handling requests and returning responses/Inertia pages.
5. **[Database Guide](./database.md)** — Drizzle schemas, migrations, seeders, and the ORM facade.
6. **[Frontend Guide](./frontend.md)** — Inertia-powered React pages, assets, and SSR coordination.
7. **[Authentication Guide](./authentication.md)** — Guards, user providers, and securing routes.
8. **[Testing Guide](./testing.md)** — Bun test harnesses, Vitest examples, and CLI helpers.
9. **[Deployment Guide](./deployment.md)** — Building, migrating, and running in production.

## Reference
- [CLI Reference](./cli.md): `guren` commands for generators, migrations, and runtime tooling.
- [Middleware Guide](./middleware.md): Writing reusable HTTP middleware and binding it to routes.
- [Overview for Agents](./AGENTS.md): Internal guidelines for contributors updating documentation.
- [Tutorials Overview](../tutorials/overview.md): Step-by-step builds covering blog posts, authentication, and ORM relationships.

## Terminology
- **Application (`my-app` etc.)**: A project scaffolded with `create-guren-app`; this is your main workspace.
- **Bootstrap**: The initialization flow in `src/main.ts` that registers routes, configures the ORM, and boots the `Application` instance.

Have suggestions or discover issues? Open an issue or submit a PR—we appreciate the feedback!
