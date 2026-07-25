---
'@guren/plugin-cloudflare': minor
---

`cloudflare:build` now bridges two real-world gaps found while migrating guren.dev to Workers:

- **drizzle-kit ↔ wrangler migration layout**: drizzle-kit 1.x emits one `<timestamp>_<name>/migration.sql` folder per migration, but wrangler's `migrations_dir` only discovers flat `*.sql` files. The build flattens each folder into `<folder-name>.sql` under `.cloudflare/d1-migrations/` (plain `*.sql` files pass through, `meta/` is skipped), and the `wrangler.jsonc` scaffold points `migrations_dir` there. `flattenD1Migrations()` is exported for scripts. The opt-in wrangler contract test now uses the real nested layout.
- **`public/index.html` no longer shadows the root route**: Workers Static Assets serves `index.html` for `/` before the worker runs; Guren apps only carry it as the dev-mode Vite shell, so the build drops it from the assets output.
- **Dev-only modules no longer bloat (or break) the bundle**: `bun:sqlite`, `vite`, and the opt-in MCP endpoint's SDK and CLI generators sit in every app's graph behind dev-time branches, and bundlers follow them regardless. The build emits throwing stubs and aliases them, cutting the guren.dev worker from 4,282 KB to 1,899 KB gzipped against the 3 MB limit.
- **The worker starts**: `NODE_ENV` and `import.meta.url` are substituted at build time. workerd leaves `import.meta.url` undefined, which breaks both Vite's `createRequire(import.meta.url)` in the SSR bundle and scaffolded `new URL(..., import.meta.url)` config — both at module scope, before anything is served. Substituting a literal is safe because Workers has no filesystem, so those paths are already meaningless there.

**Upgrading an existing Cloudflare app:** the scaffold never overwrites your `wrangler.jsonc`, so the build now warns with the exact `alias`, `define`, and `migrations_dir` entries to add — without them the worker fails to start or silently skips migrations.
