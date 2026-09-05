---
'@guren/cli': minor
---

`make:agent`, and `guren check` now reads the agent registry

`bunx guren make:agent Triager` scaffolds a durable agent — and, more
importantly, the two things that make it real: it registers the class in
`config/agents.ts`, and it extends `guren.arch.ts` with the boundary that keeps
agent code off your models, `db/`, and `@guren/orm`. An agent acts through the
tool surface or not at all, and that is now enforced by the existing
`guren check --arch` gate rather than left to review.

Both edits go through the AST, and anything it cannot patch is reported with
the exact text to paste rather than skipped — a class that looks registered and
is not would deploy as an agent that never runs.

`guren check` gains an agent-registry check, content-activated so an app
without `config/agents.ts` is unaffected. It fails on a registry the Cloudflare
build cannot read statically (a spread, a computed key, a `module` assembled
from a variable — all valid TypeScript that would leave the deploy with no
agents mounted), on a `module` that does not exist or does not export the class
it names, and on a scope a registration may not hold. It warns when an agent is
scoped to a tool no route declares. Under `--json` the report carries what each
agent's scopes expand to, recomputed from the route graph on every run.
