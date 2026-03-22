# @guren/core — AI Coding Notes

## Purpose
- Recommended public entrypoint for application code.
- Re-exports the stable framework surface from `@guren/server` + `@guren/orm`.
- Exposes the `guren` CLI by proxying to `@guren/cli` (`src/bin.ts`).
- Re-exports Bun/dev helpers through `@guren/core/runtime` and `@guren/core/vite`.

## Responsibilities
- Keep the standard application path cohesive: `@guren/core` for framework APIs, `@guren/core/runtime` for Bun helpers, `@guren/core/vite` for Vite tooling.
- Wire default ORM adapter if automatic configuration is required in future iterations.
- Avoid exposing Bun-only helpers from the root entrypoint.

## Conventions
- `src/index.ts` should stay a thin barrel file—avoid re-implementing logic here.
- When adding Bun/Vite-specific APIs, prefer `src/runtime.ts` or `src/vite.ts` over widening the root surface.
- `package.json` should pin sibling `@guren/*` packages using caret ranges that match the current release (e.g. `^0.1.1-alpha.0`) so published artifacts resolve correctly outside the monorepo.

## Build
- Build with `bun run --cwd packages/core build`.
- Ensure new exports pass through TypeScript declarations by touching only the barrel.
