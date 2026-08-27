# create-guren-app

## Purpose
Scaffolding CLI that copies templates from `templates/default` and replaces tokens. Generates apps targeting `@guren/core`, `@guren/orm`, and `@guren/cli`.

## Key Files
- `src/cli.ts`: Citty command definition
- `src/blueprints.ts`: blueprint registry, template layering, database-variant files
- `src/utils.ts`: filesystem helpers (`directoryExists`, `isDirectoryEmpty`, etc.)
- `src/git.ts`: the `--git` subprocess calls, each bounded by a timeout
- `templates/default`: Bun project template; token map lives in `cli.ts`
- `templates/blog`: curated blog starter, overlaid on `templates/default`

## Conventions
- **Never put a file literally named `.gitignore` in `templates/`.** npm strips those from published tarballs, so it works from the monorepo and ships nothing to real users. Name it `_gitignore`; `copyLayer` restores the dot after each layer copies. `tests/templates.test.ts` guards this.
- Keep template imports aligned with the latest package split (use scoped packages, not legacy `guren`)
- When adding templates, register them via the token replacement list and ensure README next-steps stay accurate
- Utilities should remain Node-compatible (no Bun-specific APIs here)

## Templates
- **Every layer must live under `templates/`** — it is the only source tree in
  the `files` field, so a layer outside it works from the monorepo and ENOENTs
  from npm. `TemplateName` makes that a type error; `tests/packaging.test.ts`
  and `auditBlueprintTemplates` check the published tarball.
- **`transformFiles` paths are read unconditionally.** A listed file that the
  blueprint does not ship makes scaffolding throw.
- **`applyDatabaseConfig` overwrites `db/schema.ts`.** A template needing more
  than the generic `users` table ships `db/schema.<driver>.ts` per driver
  instead; the scaffolder selects one and deletes the others.
- **`config/database.ts` ships as real per-driver sources** under
  `templates/database/<driver>/config/database.ts`, copied verbatim (no
  tokens) — `templates/database` is not a blueprint layer and is never copied
  wholesale. Each variant imports its own dialect's factory and re-exports
  that dialect's seeder context as `AppSeederContext` (the bare
  `SeederContext` is PostgreSQL-shaped and rejects a MySQL or SQLite schema —
  the alias is what keeps the shipped seeders portable). The files hardcode
  the same URL `DATABASE_DEFAULTS` feeds into `.env`;
  `tests/database-config-template.test.ts` pins that alignment, plus parse,
  the driver↔factory pairing, the verbatim copy, and tarball inclusion. Like
  every template here, these files are excluded from typecheck (they resolve
  `@guren/*` from npm); the starter smokes typecheck them inside a real
  scaffold.
- **`drizzle.config.ts` ships the same way**, at
  `templates/database/<driver>/drizzle.config.ts`. Each variant inlines its
  driver's `DATABASE_DEFAULTS` url and dialect (note postgres declares
  `postgresql`, not the driver key), and only the SQLite variant carries the
  DATABASE_URL guard — Postgres and MySQL take a real connection string there,
  so a scheme check would reject every valid value they have. The same test
  file pins those inlined constants, parse, the verbatim copy, and tarball
  inclusion; `tests/drizzle-config-guard.test.ts` executes the scaffolded
  SQLite config so a guard that is present but inert still fails.
  These three are the *only* `drizzle.config.ts` under `templates/` — the base
  templates deliberately ship none. `applyDatabaseConfig` writes the file
  unconditionally on the one scaffold path, so a copy in `templates/default`
  or `templates/api-only` is overwritten before the user ever sees it: that is
  how the `guren make:module` comment sat in two dead files for as long as it
  did. Comments meant for a scaffolded app belong in these variants, and
  adding a base-template copy back only recreates the dead file. Nothing
  enumerates the path either (`transformFiles` does not list it, and both
  template tsconfigs reach it through their `*.ts` glob), so the scaffolded
  app still picks up the written file.
- **Advertise nothing without a smoke.** Each blueprint gets a
  `smoke:starter:<name>` script and a CI step — `bun run typecheck` and
  `bun run build` inside a real scaffold are the only things that catch a
  template drifting from the framework.
- **`templates/blog` was authored from canonical generator output** (`guren add
  auth` + `guren add resource posts` on the default template) and then curated.
  Regenerating that output is the cheapest way to see what the framework now
  considers idiomatic when the template needs updating.

## Build
- Build with `bun run --cwd packages/create-app build`
- Update `package.json` bin/export when renaming CLI entry
