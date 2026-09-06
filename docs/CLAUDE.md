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

## The Guren Tutorial (`tutorials/NN-*.md`)

- Chapter files are `NN-<slug>.md` in course order; the mini-blog series
  (`overview.md` and friends) is the older set and follows none of this
- Every chapter after 1 keeps the four beats of RFC 0019: build the chapter's
  one concept by hand, specify the next slice with a failing test, delegate
  that slice (prompt verbatim, plus a deterministic fallback), verify with a
  rubric, `bunx guren gate`, `bun run build`, and a commit
- Never show "the code the agent will write"; the hand-written version is the
  reference and the test, rubric and gate judge the agent's
- Fences carry attributes after the language, and `smoke:tutorial` executes
  them in order: `bash run`, `bash run expect-fail` (the red step; a zero exit
  fails the smoke), `bash run background` (a server; the smoke reads the port
  from its banner), `<lang> file=<app-relative path>` (the complete file, never
  an excerpt), `<lang> manual` (shown, never run; any language). Add `fallback` to a `run` or
  `file=` block that stands in for an agent beat. A `run` block that is exactly
  `cd <dir>` moves the app root; `bunx create-guren-app …` is the one command
  the smoke swaps for the checkout's scaffolder, flags passed through
- Code is identical in both locales, test names and UI strings inside `file=`
  blocks included; `audit:tutorial-blocks` compares the executable blocks of
  `docs/ja/tutorials/` to the English ones byte for byte
- `bun run audit:tutorial-blocks` after editing; `GUREN_TUTORIAL_THROUGH=01
  bun run smoke:tutorial` to execute the chapters up to one

## Maintenance Checklist
- After editing, run `rg` on `docs/` for disallowed terms (`packages/core`, `citty`, `consola`, etc.)
- Keep Quick Start and Getting Started aligned whenever the scaffold workflow changes
- Update examples promptly if `create-guren-app` template changes
- Keep `testing.md` synchronized with `@guren/testing` helpers and CLI commands
