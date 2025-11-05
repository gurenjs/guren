# Getting Started

This guide shows how to scaffold and run a brand-new Guren application using the `create-guren-app` CLI. The instructions target macOS and Linux, and they also work on Windows with WSL2.

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
bunx create-guren-app my-app
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

## 3. Configure Environment Variables

Copy the bundled template and adjust values as needed:

```bash
cp .env.example .env
```

Key settings:
- `APP_URL`: Base URL reported to Inertia.
- `DATABASE_URL`: Postgres connection string (defaults to `postgres://guren:guren@localhost:54322/guren`).
- `PORT`: HTTP port for the dev server (default `3333`).

## 4. Provision PostgreSQL

You can use any Postgres 15+ instance. The simplest approach during development is to launch a disposable container:

```bash
docker run --name guren-postgres \
  -e POSTGRES_USER=guren \
  -e POSTGRES_PASSWORD=guren \
  -e POSTGRES_DB=guren \
  -p 54322:5432 \
  -d postgres:15
```

Stop the container with `docker stop guren-postgres` when you are done. If you already have a database, just update `DATABASE_URL` instead.

## 5. Run the Development Server

```bash
bun run dev
```

- Visit `http://localhost:3333` to see the default home page.
- Hot reloading is handled via Bun + Hono, so backend changes apply immediately.
- Frontend assets are transformed on demand by the dev server—`autoConfigureInertiaAssets` points the HTML response at Vite during development, so no separate build step is necessary.
- The Bun process also spawns the Vite dev server automatically. Set `GUREN_DEV_VITE=0` if you prefer to run Vite yourself (for example inside an IDE task).
- When the server boots you’ll see a crimson ASCII banner with the current Guren version and helpful URLs. Set `GUREN_DEV_BANNER=0` if you ever want to suppress it (for example in automated scripts).

## 6. Next Steps

- Generate resources with the `guren` CLI, for example:
  - `bunx guren make:controller PostsController`
  - `bunx guren make:model Post`
  - `bunx guren make:view posts/Index`
- Apply migrations and seed data via:
  - `bun run db:migrate`
  - `bun run db:seed`

## Production Build
When you are ready to ship:

```bash
NODE_ENV=production bun run build
```

This runs both the client and SSR builds, emitting hashed assets under `public/assets/` plus manifests that `autoConfigureInertiaAssets` reads at runtime. Deploy the project as-is and the Bun server will stream SSR HTML on first request.

## Additional Resources
- Learn about framework internals in [Architecture](./architecture.md)
- Explore the command-line tooling via the [CLI Reference](./cli.md)
- Found an issue or have ideas? Please open an issue or PR—we welcome contributions.
