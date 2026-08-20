# @guren/cli

## Purpose
Ships the Citty-based CLI (`guren` bin) with generators and database helpers. Generates code targeting `@guren/core` and `@guren/orm` imports. Provides runtime utilities (`dev`, `console`) and typed route generation for client helpers.

## Key Commands
- `make:controller`, `make:model`, `make:view`, `make:route`, and `make:test` share writer utilities; keep templates under `templates/`
- `make:auth` scaffolds controllers, views, provider, migration, and seeders for the default auth experience
- `db:migrate`, `db:seed` resolve `config/database.*` and execute exported hooks
- `routes:types` emits declaration files via `routes-types.ts` and the Vite plugin in `vite/route-types.ts`
- `dev` and `console` load the app through `runtime.ts`; update the bootstrap helpers if `src/main.ts` contracts change

## Conventions
- Keep templates minimal and framework-agnostic; they should not hardwire project-specific paths beyond `app/`, `routes/` defaults
- Utilities live in `camelCase.ts` modules
- Generator templates come in two forms, chosen by whether the contents depend on flags or fields:
  - **Fully static files** live under `templates/scaffold/<scaffold>/` as real `.ts`/`.tsx` sources, loaded via `loadScaffoldTemplate()` (`scaffold-templates.ts`). The tree mirrors the generated app (template path = written path), so `bun run typecheck:templates` (`tsconfig.templates.json`) typechecks them as an app-shaped project against the workspace packages, with companion stubs in `tests/fixtures/scaffold-typecheck/` for the files a generator builds dynamically. Note the limit: this checks against workspace *source*, so a template using a not-yet-released `@guren/*` API still passes — that class of drift belongs to `smoke:starter:npm`.
  - **Flag- or field-dependent output** stays a `build*Template()` function beside its generator, as a template literal with trailing newline. Don't move these to files: placeholder/engine syntax would make them unparseable, losing exactly what the file form exists for.
  - Either way, `tests/scaffold-output.test.ts` renders representative outputs and requires them to parse. Its covered set derives from `builtinSubCommands`, so a new `make:*` command fails that gate until it joins the matrix (new flags still need a matrix entry by hand) or names its reason in `SKIPPED_GENERATORS`. Note the asymmetry: static templates are *typechecked*, builder output is only parse-checked.
- Ensure new commands reuse `toWriterOptions` and shared logging via `consola`
- Keep `runtime.ts` as the single entry for boot helpers; extend `MaybeApplication` instead of reaching into app internals from commands
- When touching route type output, regenerate `examples/blog/types/generated/routes.d.ts` to verify compatibility
- Prefer defining subcommands with `defineCommand()` and wiring the root command via `runCli()` from `run-cli.ts` (citty's own `runMain()` reports each failure twice and exits the process itself)
- Reuse shared option helpers (such as the `force` writer option) instead of ad-hoc flag parsing
- Parse app-authored source only through `parseSourceFile()` / `ParseCache` (`parse-cache.ts`); never call `@babel/parser` directly, and pass the file path so plugin selection can order its attempts. Plugin choice is not a per-call detail — no single set parses every decorator dialect and JSX/cast combination TypeScript accepts, and a wrong set makes the whole file unparseable, which every caller treats as "contributes nothing" without saying so

## Build & Distribution
- Built via `bun run --cwd packages/cli build`; bin entry is `src/bin.ts`
- Update `package.json` exports/bin when adding new entry points
