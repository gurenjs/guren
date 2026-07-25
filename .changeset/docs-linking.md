---
'@guren/cli': minor
---

feat: doc–code linking (RFC 0004 Part 2)

- `docs/` frontmatter convention: markdown under `docs/` (and
  `modules/*/docs/`) can declare `kind`, `status`, `entities`,
  `related` (paths or globs), and `last_reviewed`.
- `guren context <Entity>` gains a **Linked docs** section, resolved
  from frontmatter `entities:` and code-side `@docs <path>` JSDoc tags
  on models and controllers.
- `guren check --docs` validates the links deterministically: dangling
  `related` paths/globs and unknown `entities` fail; entities whose
  only docs are superseded warn; `--docs-ttl <days>` warns on stale
  `last_reviewed`. Content-activated — apps without the convention see
  zero results — and participates in `check --changed`. Doc-link
  results also appear in plain `guren check`, so agent-harness edit
  hooks surface dangling links when the files they govern change —
  intentional: that is exactly when the link should be fixed.
  `--arch --docs` together runs the union of both suites.
- `make:adr "Title"` scaffolds numbered ADRs under `docs/adr/` with
  prefilled, linkable frontmatter (`--module` targets a module's docs).
