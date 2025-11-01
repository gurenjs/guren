# @guren/server — AI Coding Notes

## Purpose
- Provides the HTTP/MVC runtime: `Application`, routing DSL, controller base class, Inertia server helpers, dev asset pipeline, and authentication primitives.
- Depends on Hono and the shared inertia client for browser assets.

## Key Exports
- `Application`, `Context`, `ApplicationContext`, plus provider contracts from `http/` and `plugins/`.
- Request helpers: `registerDevAssets`, `configureInertiaAssets`, `parseRequestPayload`, `formatValidationErrors`.
- MVC suite (`Controller`, `Route`, `ViewEngine`, `inertia` utilities).
- Auth surface (`AuthManager`, `SessionGuard`, `ModelUserProvider`, `ScryptHasher`, etc.) and middleware helpers from `http/middleware`.
- Build tooling (`gurenVitePlugin`) for typed routes and dev asset integration.

## Conventions
- Files exporting classes stay PascalCase (`Application.ts`, `Controller.ts`).
- Helper modules remain kebab-case (`dev-assets.ts`, `inertia-assets.ts`).
- Avoid referencing ORM code directly; cross-package glue should live in `@guren/core`.
- Keep Bun-specific APIs isolated so tests and Vitest helpers can stub them (`configureInertiaVitest` relies on these seams).
- Sync middleware/session changes with the CLI auth scaffolds and `@guren/testing` mocks.

## Build & Dev
- Build with `bun run --cwd packages/server build`.
- When touching asset middleware, keep Bun-only APIs behind runtime checks to allow non-Bun consumers to stub them.
- Validate Vite plugin changes against `examples/blog/vite.config.ts` and the CLI `routes:types` command to avoid regressions.
