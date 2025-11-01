# @guren/core — AI Coding Notes

## Purpose
- Aggregator package that re-exports `@guren/server` + `@guren/orm` for backwards compatibility.
- Exposes the `guren` CLI by proxying to `@guren/cli` (`src/bin.ts`).

## Responsibilities
- Keep surface API stable; any breaking change in subpackages should be reflected here with deprecation messaging.
- Wire default ORM adapter if automatic configuration is required in future iterations.
- Mirror newly added exports from `@guren/server` or `@guren/orm` through the barrel so legacy `guren` imports stay feature complete.

## Conventions
- `src/index.ts` should stay a thin barrel file—avoid re-implementing logic here.
- `package.json` must depend on the workspace packages via `workspace:*` ranges.

## Build
- Build with `bun run --cwd packages/core build`.
- Ensure new exports pass through TypeScript declarations by touching only the barrel.
