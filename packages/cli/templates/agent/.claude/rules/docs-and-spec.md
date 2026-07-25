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

Markdown under `docs/` (and `modules/<name>/docs/`) declares what it
governs via frontmatter:

```yaml
---
kind: adr                # adr | context | guide
status: accepted         # adr only: draft | accepted | superseded
entities: [User, Invoice]
related:
  - app/Http/Controllers/InvoiceController.ts
  - modules/billing/**
last_reviewed: 2026-07-25
---
```

- `entities` links by model class name (survives file moves) — this is
  what `guren context <Entity>` traverses.
- Code can link back with a JSDoc tag: `/** @docs docs/adr/0007-billing.md */`.
- Record decisions with `bunx guren make:adr "Title"` — numbered file
  under `docs/adr/` with prefilled frontmatter. `--entity <Model>` fills
  `entities:`/`related:` automatically.

`guren check` reports broken links — a renamed `related` path, an
unknown entity, a dangling `@docs` tag — as failures in its output;
`guren check --docs` is the CI gate (exits non-zero on them). **After
implementing a decision, add the entity to its ADR's `entities:`
list.** After renaming or moving files a doc references, update the
doc's frontmatter in the same change.

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
