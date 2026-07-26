# Documentation Guidelines

## Audience & Scope
- Write every page for developers who scaffold fresh apps with `create-guren-app`
- Focus on what ships inside a generated project. Avoid discussing the framework's internal packages or monorepo layout
- Keep examples framework-agnostic beyond the standard scaffold

## Content Principles
- Prefer step-by-step flows starting with `bunx create-guren-app <name>`
- Use Postgres as the canonical database, but describe setup generically
- Highlight how routing, controllers, models, and Inertia views fit together without mentioning internal implementation details such as `citty`, `consola`, or package directories

## Tone & Style
- Concise, active, welcoming. Assume readers understand modern TypeScript tooling
- Use second-person ("you"). Avoid passive voice and apologetic phrasing
- Prefer fenced code blocks with explanations for commands

## Cross-Linking
- Link between docs using relative paths (e.g. `[Getting Started](./getting-started.md)`)
- Use `overview.md` as the entry point for new readers
- Surface the most relevant next steps at the end of each document

## Maintenance Checklist
- After editing, run `rg` on `docs/` for disallowed terms (`packages/core`, `citty`, `consola`, etc.)
- Keep Quick Start and Getting Started aligned whenever the scaffold workflow changes
- Update examples promptly if `create-guren-app` template changes
- Keep `testing.md` synchronized with `@guren/testing` helpers and CLI commands
