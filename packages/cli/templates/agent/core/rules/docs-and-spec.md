---
description: Linked docs (ADRs, business context) and generated spec views — how they connect to code and stay verified
globs:
  - "docs/**"
  - "db/schema.ts"
  - "app/Models/**"
  - "app/Http/Controllers/**"
  - "routes/**"
  - "resources/js/pages/**"
  - "modules/**"
---

# Docs & Spec Views

## Start entity work with the context bundle

Before touching a model or its surroundings, pull everything the project
knows about it in one shot:

```bash
bunx guren context User          # model, routes, controller, pages, resource, policy, linked docs
bunx guren context User --json   # machine-readable
```

Same-named models across modules: add `--module <name>` (`--module app`
selects the application root). The **Linked docs** section lists the ADRs
and context documents that govern the entity — read them before changing
behavior they describe.

## Linking docs to code

`docs/` (and each `modules/<name>/docs/`) is an OKF (Open Knowledge
Format) bundle: markdown files with YAML frontmatter, where `type` is
the one required field. A doc declares what it governs via frontmatter:

```yaml
---
type: adr                # REQUIRED. adr | context | guide | spec | …
status: stable           # draft | stable | deprecated (absent = stable)
entities: [User, Invoice]
related:
  - app/Http/Controllers/InvoiceController.ts
  - modules/billing/**
generated: { by: my-agent/1.0, at: 2026-07-25T09:00:00Z }
verified: { by: human:ada, at: 2026-07-26T09:00:00Z }
stale_after: 2026-12-31  # optional; stale on/after this day
---
```

- `entities` links by model class name (survives file moves) — this is
  what `guren context <Entity>` traverses. `related` links files or
  globs. Both are Guren extensions to OKF and are validated strictly.
- Ordinary markdown links in the body (`[customers](/adr/0002-x.md)`,
  `[controller](../../app/Http/Controllers/InvoiceController.ts)`) are
  OKF's relation mechanism and are validated too — a leading `/` means
  the doc's own `docs/` bundle root; relative paths may reach into the
  app.
- `generated` records who wrote the content (`human:<id>`,
  `process:<id>`, or `<producer>/<version>` for agents — use your own
  actor when you write docs); `verified` records who confirmed it.
  `index.md` and `log.md` are reserved for navigation/history, never
  concepts.
- Code can link back with a JSDoc tag: `/** @docs docs/adr/0007-billing.md */`.
- Record decisions with `bunx guren make:adr "Title"` — numbered file
  under `docs/adr/` with prefilled frontmatter. `--entity <Model>` fills
  `entities:`/`related:`; `--by <actor>` sets `generated.by` (defaults
  to the git author).

`guren check` reports broken links — a missing `type`, a renamed
`related` path, an unknown entity, a dangling `@docs` tag — in its
output; `guren check --docs` is the CI gate (exits non-zero on
failures; broken body links and passed `stale_after` dates warn).
**After implementing a decision, add the entity to its ADR's
`entities:` list.** After renaming or moving files a doc references,
update the doc's frontmatter in the same change.

Ask before you break: `bunx guren docs:graph --path <file>` (or the
`guren_docs_graph` MCP tool) shows which documents govern a file and
which spec views regenerate from it — the neighborhood of one node in
the relation graph. Query it *before* renaming or moving something a
doc might reference; `guren check` only reports the breakage after.

## Browsing the bundle: the docs viewer

`bun run dev` mounts a read-only viewer at
`http://localhost:3333/_guren/docs` (the `dev` script's `GUREN_DOCS=1`;
dev-only, loopback-only): the whole bundle as an interactive relation
graph — docs, entities, and code as nodes, validated links as edges,
click-through to each document with its frontmatter and trust tier.
Point the developer there when they ask how the docs hang together;
it renders the same data `guren context` and `guren check --docs` use.

## Generated spec views (docs/spec/)

If `docs/spec/` exists, it holds generated views (ER diagram, domain
model, screens, module map). They are derived from code and drift-gated:

```bash
bunx guren spec:generate     # regenerate after schema/model/route/page changes
bunx guren check --spec      # verify (CI gate; exits non-zero on drift)
```

When `guren check` reports `docs/spec/*.md is out of date`, run
`bunx guren spec:generate` and include the regenerated files in the same
commit as the code change — the diff shows reviewers exactly what your
change did to the spec. Never edit `docs/spec/` files by hand.
