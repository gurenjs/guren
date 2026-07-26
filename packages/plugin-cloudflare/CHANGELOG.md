# @guren/plugin-cloudflare

## 0.2.0

### Minor Changes

- 5348a76: `cloudflare:build` now bridges two real-world gaps found while migrating guren.dev to Workers:

  - **drizzle-kit ↔ wrangler migration layout**: drizzle-kit 1.x emits one `<timestamp>_<name>/migration.sql` folder per migration, but wrangler's `migrations_dir` only discovers flat `*.sql` files. The build flattens each folder into `<folder-name>.sql` under `.cloudflare/d1-migrations/` (plain `*.sql` files pass through, `meta/` is skipped), and the `wrangler.jsonc` scaffold points `migrations_dir` there. `flattenD1Migrations()` is exported for scripts. The opt-in wrangler contract test now uses the real nested layout.
  - **`public/index.html` no longer shadows the root route**: Workers Static Assets serves `index.html` for `/` before the worker runs; Guren apps only carry it as the dev-mode Vite shell, so the build drops it from the assets output.
  - **Dev-only modules no longer bloat (or break) the bundle**: `bun:sqlite`, `vite`, and the opt-in MCP endpoint's SDK and CLI generators sit in every app's graph behind dev-time branches, and bundlers follow them regardless. The build emits throwing stubs and aliases them, cutting the guren.dev worker from 4,282 KB to 1,899 KB gzipped against the 3 MB limit.
  - **The worker starts**: `NODE_ENV` and `import.meta.url` are substituted at build time. workerd leaves `import.meta.url` undefined, which breaks both Vite's `createRequire(import.meta.url)` in the SSR bundle and scaffolded `new URL(..., import.meta.url)` config — both at module scope, before anything is served. Substituting a literal is safe because Workers has no filesystem, so those paths are already meaningless there.

  **Upgrading an existing Cloudflare app:** the scaffold never overwrites your `wrangler.jsonc`, so the build now warns with the exact `alias`, `define`, and `migrations_dir` entries to add — without them the worker fails to start or silently skips migrations.

- db4450e: Added `@guren/plugin-cloudflare` — the Cloudflare Workers deploy adapter (RFC 0003 Part 1). `createWorkersHandler(app)` wraps a Guren `Application` in a Workers module handler with lazy, deduplicated boot on the first request (bindings arrive with `fetch`, so boot cannot run at module scope) and passes each request's `env`/`ExecutionContext` through to Hono untouched. `getWorkersEnv<Env>()` exposes the first request's bindings to boot-time config behind a write-once holder, and `guren cloudflare:build` assembles a deployable `.cloudflare/` directory: the app's canonical build, a generated worker entry that statically wires the built SSR bundle, copied static assets for Workers Static Assets, and a `wrangler.jsonc` scaffold (D1 binding, `nodejs_compat`, drizzle migrations dir).

  The plugin's provider follows the `definePlugin()` factory shape (`cloudflarePlugin()` — configuration reserved for upcoming session/OAuth-state wiring), so there is no auto-registered class provider; the CLI command works regardless via the `gurenPlugin.commands` manifest.

  Supporting additions: `setInertiaSsrRenderer()` in `@guren/server` registers a process-wide default SSR renderer (per-call `ssr.render` still wins) so filesystem-free runtimes can use a static import instead of the `GUREN_INERTIA_SSR_ENTRY` dynamic import, and `TestApp.fromWorkers(handler, { env })` in `@guren/testing` drives a Workers-style handler with a fake `ExecutionContext` for testing the lazy-boot lifecycle.

### Patch Changes

- Updated dependencies [88b45c4]
- Updated dependencies [360d1f4]
- Updated dependencies [1a6b738]
  - @guren/core@1.3.0
