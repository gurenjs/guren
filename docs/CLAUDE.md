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
- The tutorial's `tutorial-*.png` are captured from the course's own app at the
  chapter they illustrate, which `GUREN_TUTORIAL_THROUGH=NN bun run
  smoke:tutorial` with `GUREN_KEEP_SMOKE_DIR=1` reproduces: welcome and sign-in
  from any chapter after 5, the posts list and the post page from 10, the
  validation errors from 4. Reset the app's database before capturing, or the
  picture shows leftovers from an earlier run

## The Guren Tutorial (`tutorials/NN-*.md`)

- Chapter files are `NN-<slug>.md` in course order; the mini-blog series
  (`overview.md` and friends) is the older set and follows none of this
- Every chapter after 1 keeps the four beats of RFC 0019: build the chapter's
  one concept by hand, specify the next slice with a failing test, delegate
  that slice (prompt verbatim, plus a deterministic fallback), verify with a
  rubric, `bunx guren gate`, and a commit. `bun run build` is not a reader step
  outside chapters 1 and 14: `smoke:tutorial` runs it after every chapter's gate
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
- Every chapter after 0 ends with two exercises, between the trip-ups and the
  Next link. They carry no answers, and no fence in them takes an attribute, so
  the smoke never runs one: the app it hands to the next chapter has to be the
  app the text built. An exercise that changes a file says to do it on a branch,
  because the next chapter rewrites whole files and would silently undo it
- `bun run audit:tutorial-blocks` after editing; `GUREN_TUTORIAL_THROUGH=01
  bun run smoke:tutorial` to execute the chapters up to one
- A chapter that passes its gate is tagged `chapter-NN` in the app's own git
  history, so a run kept with `GUREN_KEEP_SMOKE_DIR=1` is navigable: `git diff
  chapter-06 chapter-07` is what that chapter changed. The tag step also fails a
  chapter that ends with an uncommitted file, which is the only check that the
  course's "every chapter ends with a commit" is true

## The Agent Course (`agent-course/NN-*.md`)

- A second course on the same fence grammar, run by `bun run smoke:agent-course`
  (`GUREN_TUTORIAL_THROUGH` and `GUREN_KEEP_SMOKE_DIR` work as for the tutorial)
  and audited by `audit:tutorial-blocks` alongside it
- The reader directs an agent through RFC 0030 plans; the prose teaches decisions
  (answer, review, approve, accept a step, resolve a held step), so every chapter
  gives its checks as a short table instead of code to type
- Every agent beat is a prompt followed by **Without an agent** fallback
  blocks. The prompt sits in a plain ` ```text ` fence with no attribute (so
  the smoke never runs it, and the site gives it a Copy button), after a
  sentence that says where to send it; a blockquote read as a citation, and
  readers did not know it was theirs to send. Both courses follow this. The fallbacks follow one reference plan per plan chapter
  (2 and 6), and chapters 2 and 6 tell a reader with their own plan how to rejoin
- Long fallback files sit inside `<details>`, so the page shows the decision and
  folds the code
- Outputs quoted in prose (a held step, an approval warning, a check's message)
  describe current CLI behaviour; after changing that behaviour, run the smoke and
  reread the chapter that quotes it, since the smoke checks exit codes, not prose

## Maintenance Checklist
- After editing, run `rg` on `docs/` for disallowed terms (`packages/core`, `citty`, `consola`, etc.)
- Keep Quick Start and Getting Started aligned whenever the scaffold workflow changes
- Update examples promptly if `create-guren-app` template changes
- Keep `testing.md` synchronized with `@guren/testing` helpers and CLI commands
