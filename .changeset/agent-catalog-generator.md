---
"@guren/cli": minor
---

Ship the agent-catalog sources and generator behind `gurenjs/agent-skills`

Adds `packages/cli/templates/agent-catalog/`: the two on-ramp skills
(`guren-new-app`, `guren-harness`) and the manifests published to the
Claude Code plugin marketplace, the Agent Skills CLI, and Agent Plugins v1
clients as `gurenjs/agent-skills` (RFC 0011). The rendered payload is not
committed; `scripts/build-agent-catalog.ts` renders it and
`audit:agent-catalog` asserts, in CI, that every `guren` command and flag
the skills name is one the CLI registers, every target is in
`AGENT_TARGETS`, and the root `plugin.json` conforms to the vendored Agent
Plugins v1 schema.

To make that audit derivable, the builtin command registry moves from
`bin.ts` into an importable `commands.ts` with no top-level side effects.
Nothing user-facing changes: `guren --help` lists the same commands.
