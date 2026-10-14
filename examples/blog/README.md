# Guren Blog Example

This example demonstrates how to build a simple blog using the Guren framework, Postgres, and Drizzle ORM.

## Prerequisites

- [Docker](https://www.docker.com/) with Compose v2 support
- Bun (the workspace already targets Bun 1.1+)

## Getting Started

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Start Postgres**
   ```bash
   bun run db:up
   ```
   The database listens on `localhost:54322` with credentials `guren / guren` and database `guren`.

3. **Configure environment**
   ```bash
   cp examples/blog/.env.example examples/blog/.env
   ```

4. **Run the example**
   ```bash
   bun run --cwd examples/blog dev
   ```
   The API server listens on http://localhost:3333 by default (override with `PORT`) and automatically launches the Vite dev server for the React frontend (typically http://localhost:5173). Set `GUREN_DEV_VITE=0` if you prefer to manage Vite yourself.

5. **Smoke test**
   ```bash
   bun run --cwd examples/blog smoke
   ```
   This waits for the application bootstrap, asserts that the home page returns SSR-rendered markup, and verifies the `/posts` JSON endpoint. If the database isn't reachable, the script exits gracefully.

## Inspecting the App

The [application graph](../../docs/en/guides/application-diagnostics.md) shows how the blog is wired without starting it. Inside this repository, call the CLI from source rather than `bunx guren`:

```bash
cd examples/blog
bun ../../packages/cli/src/bin.ts graph --json
```

The command exits 1 here because some sections are `partial`; the JSON is still printed in full. What the blog's graph holds:

- `posts.show` (`GET /posts/:id`) has a `handles` edge to `PostController`, which `renders` `posts/Index`, `posts/Show`, `posts/New` and `posts/Edit`, each with the line of the action that names the page.
- `posts.edit` also `binds` `Post` (from `bind: { id: Post }`) and `usesMiddleware` `auth`.
- `PostController` `validates` with `PostIdParamSchema` and `PageQuerySchema` from `app/Http/Validators/PostValidator.ts`.
- `coverage.handles` and `coverage.usesMiddleware` are `partial` (`controller-identity`, `inline-middleware`). `coverage.validates` is `partial` because the auth module's `OAuthController` validates with schemas declared in the controller file; those stay in `unresolved` instead of being guessed.
- There are no `tests` edges: the blog's controller tests call actions directly rather than sending requests through `TestApp`, so no test reaches a route.

`bun run dev` already sets `GUREN_MCP=1` and `GUREN_DOCS=1`. With it running, http://localhost:3333/_guren opens the Dev Center, which shows the same graph and the server errors the app hit recently. A request that fails with a 5xx also appears in

```bash
bun ../../packages/cli/src/bin.ts runtime:errors --json --url http://127.0.0.1:3333
```

with its route (`posts.show` for a failing `GET /posts/1`) and project-relative stack locations, which lead back to the nodes the graph reports. A production build mounts neither endpoint.

## Shutting Down

```bash
bun run db:down
```

Logs are available through `bun run db:logs`.

## Building for Production

```bash
NODE_ENV=production bun run --cwd examples/blog build
```
The `build` script runs both `bunx vite build` and `bunx vite build --ssr`, generating the client manifest at `public/assets/.vite/manifest.json` and the SSR manifest at `public/assets/.vite/ssr-manifest.json`. At runtime `src/main.ts` calls `autoConfigureInertiaAssets`, which reads those files and automatically sets the `GUREN_INERTIA_*` environment variables so server-side rendering is enabled without extra configuration.

To preview that production build locally, run:

```bash
NODE_ENV=production bun run --cwd examples/blog preview
```

This boots the same Bun server in production mode, using the generated manifests, rather than Vite's static preview server.

## Database Tasks

- `bun run --cwd examples/blog db:make` – generate a new SQL migration via drizzle-kit.
- `bun run --cwd examples/blog db:migrate` – apply pending migrations.
- `bun run --cwd examples/blog db:seed` – execute all configured seeders.
