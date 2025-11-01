# Repository Guidelines

## Project Structure & Module Organization
- `src/` hosts the TypeScript source for `@guren/testing`; `index.ts` re-exports public helpers from modules such as `controller.ts`, `inertia.ts`, and `vitest.ts`.
- Compiled artifacts are emitted to `dist/` via `tsup`. Never edit `dist/` manually—changes belong in `src/`.
- Keep package-scoped fixtures under `src/__fixtures__` if you introduce them; co-locate helper-specific tests beside the helper to keep intent obvious.
- Documentation and usage notes for consumers should live in JSDoc or the root README so they surface in published typings.

## Key Helpers
- `createControllerContext`, `createGurenControllerModule`, and `readInertiaResponse` underpin controller + Inertia testing; extend them before recreating similar utilities downstream.
- `configureInertiaVitest` stubs Bun globals and Inertia React internals—keep it idempotent and guard against multiple registrations.
- `createInertiaReactMock`, `setInertiaPage`, and `resetInertiaPage` power Vitest DOM expectations; keep overrides minimal to avoid diverging from real behavior.

## Build, Test, and Development Commands
- `bun run --cwd packages/testing build` runs `tsup` once and refreshes `dist/`; execute before publishing changes.
- `bun run --cwd packages/testing dev` watches `src/` and rebuilds on save—ideal while iterating on helpers.
- `bun run --cwd packages/testing typecheck` calls `tsc --noEmit` to validate declaration output.
- Repository-wide `bun test` exercises integration suites in `examples/blog`; add package-level tests with `bun run --cwd packages/testing test` once the script exists.

## Coding Style & Naming Conventions
- Follow 2-space indentation, ES module syntax, and TypeScript strict mode. Export types with `PascalCase`, functions with `camelCase`, and filenames using `kebab-case` where multiple words exist.
- Expose new utilities via named exports; update `src/index.ts` to preserve the stable module surface.
- Prefer small, composable helpers that mirror Testing Library ergonomics. Add inline comments sparingly, focusing on intent over mechanics.

## Testing Guidelines
- Use Vitest (`import { describe, it, expect } from 'vitest'`) for unit coverage. Place specs as `*.test.ts` adjacent to the implementation.
- When helpers wrap external APIs (e.g., Inertia), mock only the minimal surface and assert through public behavior to keep tests resilient.
- Document any required environment setup (DOM globals, adapters) inside the spec or export ready-made setup functions from this package.
- Run `configureInertiaVitest()` at test entry points used by consumers (e.g., `tests/setup.ts`) so exported mocks stay in sync with framework behavior.

## Commit & Pull Request Guidelines
- Favor Conventional Commits scoped to the package, e.g., `feat(testing): add inertia page loader`. Limit each commit to one logical change and ensure build + typecheck pass locally.
- Pull requests should summarize new helpers, note compatibility considerations, and list validation steps (`build`, `typecheck`, downstream app checks) so reviewers can verify quickly.
