# Documentation Guidelines for Agents

This guide captures the decisions established in recent documentation updates so future contributors can keep the docs consistent.

## Audience & Scope
- Write every page for developers who scaffold fresh apps with `create-guren-app`.
- Focus on what ships inside a generated project. Avoid discussing the framework’s internal packages or monorepo layout.
- Keep examples framework-agnostic beyond the standard scaffold. Do not reference repository-specific helper scripts.

## Content Principles
- Prefer step-by-step flows that start with `bunx create-guren-app <name>`, then cover dependency installation, environment configuration, database setup, and running the dev server.
- Use Postgres as the canonical database, but describe setup generically (e.g. “ensure your Postgres instance is running”) rather than pointing to local convenience commands.
- Highlight how routing, controllers, models, and Inertia views fit together without mentioning internal implementation details such as `citty`, `consola`, or package directories.

## Tone & Style
- Keep the language concise, active, and welcoming. Assume readers understand modern TypeScript tooling.
- Use second-person (“you”) when giving instructions. Avoid passive voice and apologetic phrasing.
- When listing commands, prefer fenced code blocks and explain what each command accomplishes.

## Cross-Linking
- Link between docs using relative paths (e.g. `[Getting Started](./getting-started.md)`) and use `overview.md` as the entry point for new readers.
- Surface the most relevant next steps at the end of each document so readers know where to go next.

## Maintenance Checklist
- After editing, run `rg` on `docs/` for disallowed terms (`packages/core`, `citty`, `consola`, `bun run db:up`, etc.) to catch regressions.
- Ensure Quick Start and Getting Started remain aligned whenever the scaffold workflow changes.
- Update examples promptly if the `create-guren-app` template adds or removes scripts, environment variables, or file structure.
- Keep `testing.md` synchronized with `@guren/testing` helpers and the latest CLI commands referenced in scaffolds (e.g. `make:test`, `routes:types`).

Following these guidelines keeps the documentation laser-focused on the user experience of building apps with Guren.
