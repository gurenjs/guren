# @guren/testing

## Purpose
Testing utilities for `@guren/server` controllers and Inertia page components.

## Key Helpers
- `createControllerContext`, `createGurenControllerModule`, and `readInertiaResponse` underpin controller + Inertia testing; extend them before recreating similar utilities downstream
- `configureInertiaVitest` stubs Bun globals and Inertia React internals — keep it idempotent and guard against multiple registrations
- `createInertiaReactMock`, `setInertiaPage`, and `resetInertiaPage` power Vitest DOM expectations; keep overrides minimal to avoid diverging from real behavior

## Structure
- `src/` hosts TypeScript source; `index.ts` re-exports public helpers from modules such as `controller.ts`, `inertia.ts`, and `vitest.ts`
- Compiled artifacts emitted to `dist/` via `tsdown` — never edit `dist/` manually
- Keep package-scoped fixtures under `src/__fixtures__` if needed; co-locate helper-specific tests beside the helper

## Conventions
- Expose new utilities via named exports; update `src/index.ts` to preserve the stable module surface
- Prefer small, composable helpers that mirror Testing Library ergonomics
- When helpers wrap external APIs (e.g., Inertia), mock only the minimal surface and assert through public behavior

## Build & Tests
- `bun run --cwd packages/testing build` — runs `tsdown` and refreshes `dist/`
- `bun run --cwd packages/testing dev` — watches `src/` and rebuilds on save
- `bun run --cwd packages/testing typecheck` — validates declaration output
