# create-guren-app

## Purpose
Scaffolding CLI that copies templates from `templates/default` and replaces tokens. Generates apps targeting `@guren/core`, `@guren/orm`, and `@guren/cli`.

## Key Files
- `src/cli.ts`: Citty command definition
- `src/utils.ts`: filesystem helpers (`directoryExists`, `isDirectoryEmpty`, etc.)
- `templates/default`: Bun project template; token map lives in `cli.ts`

## Conventions
- **Never put a file literally named `.gitignore` in `templates/`.** npm strips those from published tarballs, so it works from the monorepo and ships nothing to real users. Name it `_gitignore`; `copyLayer` restores the dot after each layer copies. `tests/templates.test.ts` guards this.
- Keep template imports aligned with the latest package split (use scoped packages, not legacy `guren`)
- When adding templates, register them via the token replacement list and ensure README next-steps stay accurate
- Utilities should remain Node-compatible (no Bun-specific APIs here)

## Build
- Build with `bun run --cwd packages/create-app build`
- Update `package.json` bin/export when renaming CLI entry
