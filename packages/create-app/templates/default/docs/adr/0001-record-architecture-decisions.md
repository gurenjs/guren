---
kind: adr
status: accepted
entities: []
related: []
---

# Record architecture decisions

## Context

Code shows *what* the system does; it cannot show *why*. Decisions —
business rules, trade-offs, rejected alternatives — live in people's
heads and get lost. AI coding agents working on this codebase have the
same problem: without recorded decisions they can only infer intent.

## Decision

We record significant decisions as numbered ADRs in this directory,
created with:

```bash
bunx guren make:adr "Title of the decision"
bunx guren make:adr "Title" --entity Invoice   # prefills the links below
```

Each ADR declares what it governs in its frontmatter:

- `entities: [Invoice]` — model class names the decision affects.
  `bunx guren context Invoice` then surfaces this ADR to anyone (human
  or agent) working on that model.
- `related: [app/Http/Controllers/InvoiceController.ts]` — files or
  globs the decision touches.
- `status:` — `draft` → `accepted`; mark `superseded` when replaced
  (and write the replacement).

`bunx guren check` verifies these links: renaming a file a doc points
at, or removing a model a doc names, fails the check until the doc is
updated. Keep frontmatter current in the same change that moves the
code.

## Consequences

Decisions stay discoverable from the code they govern, at the cost of
writing them down and keeping links fresh — which the checker enforces,
so the links can be trusted.
