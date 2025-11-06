# Web

Welcome to your new Guren application. This template ships with Inertia server-side rendering enabled out of the box.

## Getting Started

1. Install dependencies with `bun install`.
2. Copy `.env.example` to `.env` and update any required values.
3. Start the development servers with `bun run dev` (runs Bun and Vite together).

During development the Bun server reads `resources/js/ssr.tsx` directly. Production builds rely on the Vite-generated SSR bundle and manifest, which are wired automatically by `src/main.ts` through `autoConfigureInertiaAssets`.

The default setup expects a PostgreSQL database. You can change the connection string in `config/database.ts` or set the `DATABASE_URL` environment variable before running the server.

## Available Scripts

- `bun run dev` - start the Bun API server alongside the Vite dev server.
- `bun run build` - build both the client and SSR bundles with Vite.
- `bun run preview` - preview the production build locally.
- `bun run routes:types` - regenerate client-side route helpers.
- `bun run db:make` - scaffold a new SQL migration from your schema using drizzle-kit.
- `bun run db:migrate` - apply database migrations.
- `bun run db:seed` - execute seeders.

### Production Builds

Run `bun run build` before deploying. This script internally executes `bunx vite build` and `bunx vite build --ssr` so the Bun server can stream pre-rendered HTML during the first request.

Tailwind CSS is ready to use out of the box. Edit `resources/css/app.css` or add utilities to your components and the dev server will pick them up automatically.

Happy hacking!
