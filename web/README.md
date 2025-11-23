# Web

Welcome to your new Guren application. This template ships with Inertia server-side rendering enabled out of the box.

## Prerequisites

- [Bun](https://bun.sh/) installed locally.
- PostgreSQL reachable at `postgres://guren:guren@localhost:54322/guren` (or override `DATABASE_URL` in `.env`). You can use any Postgres instance; Docker is fine as long as the URL matches.

## Quickstart

1. Install dependencies: `bun install`.
2. Copy environment: `cp .env.example .env` and adjust `DATABASE_URL` if needed.
3. Generate route types once so the client picks up links: `bun run routes:types`.
4. Start dev servers (Bun API + Vite dev server with hot reload): `bun run dev`.

During development the Bun server reads `resources/js/ssr.tsx` directly. Production builds rely on the Vite-generated SSR bundle and manifest, wired automatically by `src/main.ts` through `autoConfigureInertiaAssets`.

## Scripts

- `bun run dev` — start Bun API + Vite dev server together.
- `bun run build` — build both the client and SSR bundles with Vite.
- `bun run preview` — preview the production build locally.
- `bun run routes:types` — regenerate client-side route helpers from `routes/web.ts`.
- `bun run typecheck` — TypeScript no-emit type check (includes tests).
- `bun run test` — run Vitest suite via @guren/testing helpers.
- `bun run db:make` — scaffold a new SQL migration from your schema using drizzle-kit.
- `bun run db:migrate` — apply database migrations.
- `bun run db:seed` — execute seeders.

## Testing & Verification

Run the following before opening a PR:

```bash
bun run routes:types
bun run typecheck
bun run test
bun run build
```

Route type generation should leave no diffs after committing. The GitHub Actions workflow (`.github/workflows/ci.yml`) enforces the same steps on pushes and pull requests.

### Production Builds

Run `bun run build` before deploying. This script internally executes `bunx vite build` and `bunx vite build --ssr` so the Bun server can stream pre-rendered HTML during the first request.

Tailwind CSS is ready to use out of the box. Edit `resources/css/app.css` or add utilities to your components and the dev server will pick them up automatically.

Happy hacking!
