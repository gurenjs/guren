---
type: adr
status: stable
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

ADRs are OKF (Open Knowledge Format) concept documents: markdown with
YAML frontmatter, where `type` is the one required field. Each ADR
declares what it governs in its frontmatter:

- `entities: [Invoice]` — model class names the decision affects.
  `bunx guren context Invoice` then surfaces this ADR to anyone (human
  or agent) working on that model.
- `related: [app/Http/Controllers/InvoiceController.ts]` — files or
  globs the decision touches.
- `status:` — `draft` → `stable`; mark `deprecated` when replaced
  (and write the replacement).
- `generated: { by, at }` — who wrote it (`human:<id>` or an agent's
  `<producer>/<version>`); `verified: { by, at }` — who confirmed it.

Once declared, the links are verified: `bunx guren check` reports a
renamed file a doc points at, or a removed model a doc names, as a
failure, and `bunx guren check --docs` gates CI on it (non-zero exit).
Ordinary markdown links between docs are checked too. Keep frontmatter
current in the same change that moves the code.

## Consequences

Decisions stay discoverable from the code they govern, at the cost of
writing them down and keeping links fresh — declared links are checked,
so they can be trusted. (An ADR with no links, like this one, is valid;
it simply isn't surfaced by `guren context`.)
