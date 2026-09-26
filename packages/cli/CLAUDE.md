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
  - Several auth scaffold templates are byte-identical to their `packages/create-app/templates/blog/` counterparts, and that identity is pinned by `tests/scaffold-blog-sync.test.ts` — a change to one side must land on both. Files that differ from the blueprint on purpose (the blog is a showcase app) pin only their behaviour-critical shared snippet instead, like `SHARE_INERTIA_AUTH_PROPS_SNIPPET` in `tests/make-auth.test.ts`; the sync test's header states the policy and how to diverge a pair deliberately.
  - Either way, `tests/scaffold-output.test.ts` renders representative outputs and requires them to parse. Its covered set derives from `builtinSubCommands`, so a new `make:*` command fails that gate until it joins the matrix (new flags still need a matrix entry by hand) or names its reason in `SKIPPED_GENERATORS`.
  - Builder output additionally gets a *compile* gate, with tsconfig.templates.json's own options (`renderedAppCompilerOptions()` in `tests/helpers.ts`), so the static and rendered halves of a scaffold are held to the same bar. `tests/scaffold-builder-typecheck.test.ts` renders make:auth's flag combinations (`--oauth --verify`, plain `--oauth`, `--oauth-only`, and one against a declared env) into a temp app, regenerates `.guren/pages.gen.ts`, and typechecks the render. `tests/make-output-typecheck.test.ts` does the same for every other `make:*`: make:feature per flag combination (`--policy --test` over every field type, `--public --module`, `--attach`), with the routes file an author writes from the printed block and the full route codegen run against it (the rendered app is *imported*, so it links `@guren/core`, `@guren/orm` and `zod` into the temp app), and every single-file generator rendered into one app beside what its output references (make:route its controller, make:resource its model). Its covered set derives from `builtinSubCommands` like the parse gate's. Combos not compiled in either differ only by omission and stay parse-checked.
- Ensure new commands reuse `toWriterOptions` and shared logging via `consola`
- Queue commands use `loadBootedApplication()` before resolving the configured
  queue manager. Worker SIGINT/SIGTERM handlers belong to one worker run and
  must be removed on completion or failure. App `stop()` only closes HTTP/Vite
  listeners; it is not a general provider or queue-driver disposal API.
- `loadApplication()` loads the entry and resolves its application without
  choosing a boot policy. dev delegates boot to listen; console warns and
  continues after boot failures; loadBootedApplication propagates them.
  Startup and queue retry failures must throw to runCli, not exit internally.
- Keep `runtime.ts` as the single entry for boot helpers; extend `MaybeApplication` instead of reaching into app internals from commands
- When touching route type output, regenerate `examples/blog/types/generated/routes.d.ts` to verify compatibility
- Define every subcommand with `defineCommand()` from `./define-command`, not from `citty`, and wire the root command via `runCli()` from `run-cli.ts` (citty's own `runMain()` reports each failure twice and exits the process itself). The wrapper is what makes a repeated flag worth its last value; importing citty's own `defineCommand` opts a command out of that silently, and the reading sites look identical either way. `tests/define-command.test.ts` gates every entry of `builtinSubCommands` on having gone through the wrapper — but it cannot reach the root command in `bin.ts` (which `runCli()` consumes at module scope) or a plugin command (which owns its own parse, deliberately: see the comment in `plugin-commands.ts`)
- Reuse shared option helpers (such as the `force` writer option) instead of ad-hoc flag parsing
- Parse app-authored source only through `parseSourceFile()` / `ParseCache` (`parse-cache.ts`); never call `@babel/parser` directly, and pass the file path so plugin selection can order its attempts. Plugin choice is not a per-call detail — no single set parses every decorator dialect and JSX/cast combination TypeScript accepts, and a wrong set makes the whole file unparseable, which every caller treats as "contributes nothing" without saying so

## Command Registration

- `src/commands.ts` composes the builtin registry in help-display order. Keep
  `builtinSubCommands` as the entry point for the CLI, audits, and scaffold tests.
- `src/commands/make.ts` owns every `make:*` command definition and execution
  wrapper. The root imports those objects without redefining their arguments or
  handlers. Generator implementations and templates stay in their existing modules.
- `src/commands/scaffold-options.ts` owns the shared writer options and scaffold
  arguments used by make, add, and codegen commands. `display-paths.ts` formats
  paths shared by migration generation and database command output.
- `src/commands/database.ts` owns the six `db:*` command definitions, reset/fresh
  sequencing, and database result messages. The production refusal lives in
  `destructive-guard.ts` and throws a `CliError`; `db:seed`, `db:reset`,
  `db:fresh`, `queue:retry` and `queue:flush` call it ahead of database loading
  and dry-run handling. `db:migrate` is not guarded and runs in production.
  `database-command-boundary.test.ts` exercises the CLI in subprocesses with
  inert database hooks, including refusal, dry-run, reset ordering, failures,
  and JSON status/rollback output.
- `src/commands/plan.ts` owns `plan` and the nine `plan:*` command definitions and CLI
  output. Plan engines stay in their existing modules. Keep application loading
  lazy and specific to each command: impact scans, detailed state, and commands
  that need no application must retain their own loading conditions.
- `src/commands/tools.ts` owns tool:* and token:issue definitions and argument
  validation. Execution stays in the existing tool/token modules. Preserve the
  tool:dev process-lifetime marker and the local defineCommand wrapper.
- These modules only construct command objects at import time. Resolve cwd,
  environment, and application state inside command execution. Use the local
  `defineCommand` wrapper so repeated flags keep their existing semantics.

## Build & Distribution
- Built via `bun run --cwd packages/cli build`; bin entry is `src/bin.ts`
- Update `package.json` exports/bin when adding new entry points
