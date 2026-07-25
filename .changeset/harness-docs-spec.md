---
'@guren/cli': minor
'create-guren-app': minor
---

feat: teach scaffolds and the agent harness the docs/spec conventions

- New apps ship with `docs/adr/0001-record-architecture-decisions.md`,
  a seed ADR explaining the frontmatter convention, `make:adr`, and the
  link checking `guren check` performs.
- The agent harness gains `.claude/rules/docs-and-spec.md` (glob-scoped
  to docs, schema, models, controllers, routes, and pages): start
  entity work with `guren context <Entity>`, keep doc frontmatter
  current when moving files, regenerate `docs/spec/` views after
  structural changes. Existing apps receive the rule via
  `bunx guren agent:sync`. The harness `CLAUDE.md` (start-here block
  and MCP tool table, now covering `guren context <Entity>`,
  `spec:generate`, `make:adr`, and `guren_entity_context`) applies to
  new `agent:init` installs — `CLAUDE.md` is user-owned and never
  overwritten by sync.
