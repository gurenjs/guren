---
'@guren/cli': minor
---

feat: derived spec views with a drift gate (RFC 0004 Part 3)

- `guren spec:generate` renders four deterministic markdown views into
  `docs/spec/`: `er.md` (Mermaid ER diagram from the Drizzle schema,
  edges from model relationships and explicit `.references()` FKs),
  `domain.md` (Mermaid class diagram of models grouped by module),
  `screens.md` (route → controller action → page → Props inventory),
  and `modules.md` (module context map with cross-module dependency
  edges). Output is byte-stable — stable sorts, no timestamps — so PR
  diffs show exactly what a code change did to the spec.
- `guren check --spec` is the tbls-style drift gate: it regenerates the
  views in memory and fails (non-zero exit) when the committed files
  differ or are missing. Content-activated on `docs/spec/`; under
  `check --changed` it only regenerates when a spec-relevant file
  (schema, models, controllers, routes, pages, resources) changed.
- The Drizzle schema parser is promoted to a shared `schema-parser.ts`
  (column types, nullability, primary keys, `.references()` targets);
  the audit's sensitive-column check and the entity context consume it.
