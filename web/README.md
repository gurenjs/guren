# Web

Welcome to your new Guren application. This template ships with Inertia server-side rendering enabled out of the box.

## Prerequisites

- [Bun](https://bun.sh/) installed locally.
- No database server. Local development uses SQLite at `SQLITE_DATABASE_PATH` (`./data/guren.db` by default); production runs on Cloudflare D1 through the `DB` binding in `wrangler.jsonc`.

## Quickstart

1. Install dependencies from the repository root: `bun install`.
2. Copy environment: `cp .env.example .env` and set `APP_KEY`, which is required to boot.
3. Generate route and page manifests once so the client picks up links: `bun run codegen`.
4. Start dev servers (Bun API + Vite dev server with hot reload): `bun run dev`.

During development the Bun server reads `resources/js/ssr.tsx` directly. Production builds rely on the Vite-generated SSR bundle and manifest, wired automatically by `src/main.ts` through `@guren/core/runtime`.

## Scripts

- `bun run dev` — start Bun API + Vite dev server together.
- `bun run build` — build both the client and SSR bundles with Vite.
- `bun run preview` — serve the built app through the Bun production server locally.
- `bun run codegen` — regenerate route helpers and page manifests from `routes/web.ts`.
- `bun run routes:types` — compatibility alias for `bun run codegen`.
- `bun run typecheck` — TypeScript no-emit type check (includes tests).
- `bun run test` — run Vitest suite via @guren/testing helpers.
- `bun run db:make` — scaffold a new SQL migration from your schema using drizzle-kit.
- `bun run db:migrate` — apply database migrations.
- `bun run db:seed` — execute seeders.

## Testing & Verification

Run the following before opening a PR:

```bash
bun run codegen
bun run typecheck
bun run test
bun run build
```

Code generation should leave no diffs after committing. The GitHub Actions workflow (`.github/workflows/ci.yml`) enforces the same steps on pushes and pull requests.

### Production Builds

Run `bun run build` before deploying. This script internally executes `bunx vite build` and `bunx vite build --ssr` so the Bun server can stream pre-rendered HTML during the first request. After building, `bun run preview` starts the same Bun server in production mode against the generated manifests instead of using Vite's static preview server.

Tailwind CSS is ready to use out of the box. Edit `resources/css/app.css` or add utilities to your components and the dev server will pick them up automatically.

Happy hacking!
