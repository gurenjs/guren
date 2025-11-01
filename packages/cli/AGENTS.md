# @guren/cli — AI Coding Notes

## Purpose
- Ships the Citty-based CLI (`guren` bin) with generators and database helpers.
- Generates code targeting `@guren/server` and `@guren/orm` imports.
- Provides runtime utilities (`dev`, `console`) and typed route generation for client helpers.

## Key Commands
- `make:controller`, `make:model`, `make:view`, `make:route`, and `make:test` share writer utilities; keep templates under `templates/`.
- `make:auth` scaffolds controllers, views, provider, migration, and seeders for the default auth experience.
- `db:migrate`, `db:seed` resolve `config/database.*` and execute exported hooks.
- `routes:types` emits declaration files via `routes-types.ts` and the Vite plugin in `vite/route-types.ts`.
- `dev` and `console` load the app through `runtime.ts`; update the bootstrap helpers if `src/main.ts` contracts change.

## Conventions
- Keep templates minimal and framework-agnostic; they should not hardwire project-specific paths beyond `app/`, `routes/` defaults.
- Utilities live in `camelCase.ts` modules; generator templates should be string literals with trailing newline.
- Ensure new commands reuse `toWriterOptions` and shared logging via `consola`.
- Keep `runtime.ts` as the single entry for boot helpers; extend `MaybeApplication` instead of reaching into app internals from commands.
- When touching route type output, regenerate `examples/blog/types/generated/routes.d.ts` to verify compatibility.

## Build & Distribution
- Built via `bun run --cwd packages/cli build`; bin entry is `src/bin.ts`.
- Update `package.json` exports/bin when adding new entry points.
