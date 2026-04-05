# Getting Started

This guide shows how to scaffold and run a brand-new Guren application using the `create-guren-app` CLI. The instructions target macOS and Linux, and they also work on Windows with WSL2.

> [!NOTE]
> If any term is unfamiliar, see the [Glossary](./glossary.md).

## Prerequisites
- **Bun 1.1 or later**  
  Install example: `curl -fsSL https://bun.sh/install | bash`
- **Docker Desktop (Compose v2)**  
  Used to run Postgres in a container.
- **Node.js (optional)**  
  Not required for runtime, but handy for editor tooling and type definitions.

Tools like **direnv** or **mise** are optional but help with managing environment variables.

## 1. Scaffold a Project

Use `bunx` (or `npx`) to generate a project in a new directory. Replace `my-app` with your desired folder name:

```bash
bunx create-guren-app my-app --mode ssr
cd my-app
```

The generator copies a template, personalises metadata, and prompts you to choose **SSR** (default) or **SPA** rendering. Pass `--mode spa` to skip the prompt or `--mode ssr` to force server-side rendering. Use `--force` if you need to scaffold into a non-empty directory.

Choosing SSR gives you `autoConfigureInertiaAssets` out of the box so Bun can discover Vite manifests automatically; the SPA preset disables SSR with the same helper.

## 2. Install Dependencies

Inside the project run:

```bash
bun install
```

This installs the framework (`guren`), Inertia client, React, and supporting dev tools (TypeScript, tsup, etc.).

## 3. Add Features

Guren ships with generators that scaffold authentication and full CRUD resources. Add them before running codegen so the generated manifests include every route and page:

```bash
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text,published:boolean"
```

`add auth` sets up registration, login, logout, and session middleware. `add resource` creates a model, migration, controller, validator, resource, and Inertia pages for the given fields. Run `bunx guren add --help` for all available generators.

## 4. Generate Route and Page Manifests

With your routes and pages in place, generate the typed manifests:

```bash
bun run codegen
```

This creates typed route helpers and the page manifest used by the Inertia integration. Re-run this command whenever you add or rename routes or pages.

## 5. Configure Environment Variables

Copy the bundled template and adjust values as needed:

```bash
cp .env.example .env
```

> [!CAUTION]
> Keep `.env` out of version control. If credentials leak in a commit, rotate the database user and regenerate any API keys referenced in the file.

Key settings:
- `APP_URL`: Base URL reported to Inertia.
- `DATABASE_URL`: Postgres connection string (defaults to `postgres://guren:guren@localhost:54322/guren`).
- `PORT`: HTTP port for the dev server (default `3333`).

## 6. Provision PostgreSQL

You can use any Postgres 15+ instance. The simplest approach during development is to launch a disposable container:

```bash
docker run --name guren-postgres \
  -e POSTGRES_USER=guren \
  -e POSTGRES_PASSWORD=guren \
  -e POSTGRES_DB=guren \
  -p 54322:5432 \
  -d postgres:17
```

Stop the container with `docker stop guren-postgres` when you are done. If you already have a database, just update `DATABASE_URL` instead.

> [!TIP]
> Already running PostgreSQL locally or in the cloud? Skip the container entirely and point `DATABASE_URL` at that instance—the rest of the guide works unchanged.

## 7. Run Migrations and Seed Data

With Postgres running, apply the database schema and populate seed data:

```bash
bun run db:migrate && bun run db:seed
```

Migrations create the tables defined by your Drizzle schema. The seeder inserts sample records so you have data to work with immediately.

## 8. Typecheck and Test

Verify everything is wired up correctly before starting the dev server:

```bash
bun run typecheck && bun run test
```

If either command reports errors, fix them now — catching issues early is much easier than debugging a running app.

## 9. Run the Development Server

```bash
bun run dev
```

- Visit `http://localhost:3333` to see the default home page.
- Hot reloading is handled via Bun + Hono, so backend changes apply immediately.
- Frontend assets are transformed on demand by the dev server—`autoConfigureInertiaAssets` points the HTML response at Vite during development, so no separate build step is necessary.
- The Bun process also spawns the Vite dev server automatically. Set `GUREN_DEV_VITE=0` if you prefer to run Vite yourself (for example inside an IDE task).
- When the server boots you’ll see a crimson ASCII banner with the current Guren version and helpful URLs. Set `GUREN_DEV_BANNER=0` if you ever want to suppress it (for example in automated scripts).

## 10. Next Steps

You now have a running app with authentication and a posts resource. From here you can:

- Add more resources: `bunx guren add resource comments --fields "body:text,postId:integer"`
- Generate individual components: `bunx guren make:controller`, `bunx guren make:model`, `bunx guren make:view`
- Explore the generated code in `app/Http/Controllers/`, `app/Models/`, and `resources/js/pages/`

## Production Build
When you are ready to ship:

```bash
NODE_ENV=production bun run build
```

This runs both the client and SSR builds, emitting hashed assets under `public/assets/` plus manifests that `autoConfigureInertiaAssets` reads at runtime. Deploy the project as-is and the Bun server will stream SSR HTML on first request.

## Additional Resources
Continue through the rest of the guides in this order:

1. [Architecture](./architecture.md)
2. [Routing Guide](./routing.md)
3. [Controller Guide](./controllers.md)
4. [Database Guide](./database.md)
5. [Frontend Guide](./frontend.md)
6. [Authentication Guide](./authentication.md)
7. [Testing Guide](./testing.md)
8. [Deployment Guide](./deployment.md)

Need tooling details along the way? Keep the [CLI Reference](./cli.md) handy, and if you spot issues or have ideas, please open an issue or PR—we welcome contributions.
