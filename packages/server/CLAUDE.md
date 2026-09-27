# @guren/server

## Purpose
Provides the HTTP/MVC runtime: `Application`, `createApp`, app-local `Router`, controller base class, Inertia server helpers, dev asset pipeline, and authentication primitives.

## Key Exports
- `Application`, `Context`, `ApplicationContext`, plus provider contracts from `http/` and `plugins/`
- `createApp` and the instance-based `Router`
- Root exports stay Node-safe: `parseRequestPayload`, `formatValidationErrors`, MVC/auth/middleware/resource APIs
- Bun/dev asset helpers live under `@guren/server/runtime`
- Build tooling (`gurenVitePlugin`) lives under `@guren/server/vite`

## Conventions
- Files exporting classes stay PascalCase (`Application.ts`, `Controller.ts`)
- Helper modules remain kebab-case (`dev-assets.ts`, `inertia-assets.ts`)
- Avoid referencing ORM code directly; cross-package glue should live in `@guren/core`
- Keep Bun-specific APIs isolated so tests and Vitest helpers can stub them (`configureInertiaVitest` relies on these seams)
- Sync middleware/session changes with the CLI auth scaffolds and `@guren/testing` mocks

- `http/server-lifecycle.ts` owns the process-wide HTTP/Vite slots, Vite adoption,
  managed asset environment, bounded shutdown, and signal-handler disposal.
  `Application` sequences startup and keeps its own HTTP handle/address.
  Check ownership after each asynchronous close before clearing shared state.
  Startup failures reject to the caller; only signal teardown ends the process.
  A Vite instance that fails to start must be closed with the same bounded policy.

## Build & Dev
- Build with `bun run --cwd packages/server build`
- When touching asset middleware, keep Bun-only APIs behind runtime checks to allow non-Bun consumers to stub them
- Validate Vite plugin changes against `examples/blog/vite.config.ts` and the CLI `codegen` command to avoid regressions

## Boot retries
- `http/boot-sequence.ts` checkpoints completed application stages and route registrars. A later failure must not replay a successful boot callback, route mount, or dev endpoint.
- ProviderManager keeps per-provider registration/boot progress; `registerAll()` still runs on each attempt so providers supplied before retry are registered.
- A failed hook can have partial effects. Retrying it is the hook owner's responsibility; use a fresh application when it cannot be retried safely. Do not claim rollback of user callbacks or external resources.
- Router resolves every route's middleware and handler before mounting any route on Hono, so a validation failure can be repaired without leaving an earlier route mounted.
