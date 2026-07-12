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

## Build & Dev
- Build with `bun run --cwd packages/server build`
- When touching asset middleware, keep Bun-only APIs behind runtime checks to allow non-Bun consumers to stub them
- Validate Vite plugin changes against `examples/blog/vite.config.ts` and the CLI `codegen` command to avoid regressions
