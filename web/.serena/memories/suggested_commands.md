# Suggested Commands
- Install deps: `bun install` (from repo root).
- Start dev (Bun API + Vite dev server): `bun run dev` (invokes `bun run dev:server` hot reload).
- Generate client route types: `bun run routes:types`.
- Build (client + SSR): `bun run build`; preview prod bundle: `bun run preview`.
- Database: `bun run db:make` (scaffold migration via drizzle-kit), `bun run db:migrate`, `bun run db:seed`; Docker Postgres runs at localhost:54322 with guren/guren.
- Entry serve script: `bun run dev:server` (watches bin/serve.ts).
- Workspace note: use `bun`/`bunx` with Bun runtime; AGENTS suggests `bunx guren` generators (make:controller/model/view/test/auth, routes:types, console, dev).
- Utilities (Darwin shell): `ls`, `cat`, `rg`/`grep`, `find`, `sed`, `git` standard usage.