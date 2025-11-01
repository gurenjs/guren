# create-guren-app — AI Coding Notes

## Purpose
- Scaffolding CLI that copies templates from `templates/default` and replaces tokens.
- Generates apps targeting `@guren/server`, `@guren/orm`, and `@guren/cli`.

## Key Files
- `src/cli.ts`: Citty command definition.
- `src/utils.ts`: filesystem helpers (`directoryExists`, `isDirectoryEmpty`, etc.).
- `templates/default`: Bun project template; token map lives in `cli.ts`.

## Conventions
- Keep template imports aligned with the latest package split (use scoped packages, not legacy `guren`).
- When adding templates, register them via the token replacement list and ensure README next-steps stay accurate.
- Utilities should remain Node-compatible (no Bun-specific APIs here).

## Build
- Build with `bun run --cwd packages/create-app build`.
- Update `package.json` bin/export when renaming CLI entry.
