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

## Diagrams & Screenshots

- Diagrams are ```mermaid fences. They render natively on GitHub, and the site
  renders them client-side — anything shiki would try to highlight instead
  becomes a grey code block, so keep the fence language exactly `mermaid`
- Prefer `flowchart LR` and `direction LR` (ER diagrams) for anything wider
  than three nodes: the docs column is much wider than it is tall, and a
  top-to-bottom chain of boxes turns into a narrow 900px-tall strip
- Screenshots live in `docs/images/` and are shared by both locales, so the
  app they show is the English scaffold. Reference them relatively
  (`![alt](../../images/name.png)`) so GitHub renders them too; the site
  rewrites the path to `/docs-images/`
- Capture screenshots from a freshly scaffolded app following the tutorial's
  own commands, never from `examples/blog` — a reader compares the picture to
  their own screen
- Every image needs real alt text describing what is on screen. It is what
  remains when the image fails to load, and it carries most of the
  accessibility value. Write it for the page it sits on — a reused image
  usually needs different wording in each context
- One image can back several docs (`grep -rn '<name>.png' docs/`), so
  recapturing one means rechecking every page that references it

## Maintenance Checklist
- After editing, run `rg` on `docs/` for disallowed terms (`packages/core`, `citty`, `consola`, etc.)
- Keep Quick Start and Getting Started aligned whenever the scaffold workflow changes
- Update examples promptly if `create-guren-app` template changes
- Keep `testing.md` synchronized with `@guren/testing` helpers and CLI commands
