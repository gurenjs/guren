---
"@guren/cli": minor
---

`agent:sync --prune` no longer deletes skill directories under names the framework never shipped

The stale-file scan claimed `.claude/skills/` and `.agents/skills/` as whole
directories, so any skill directory the current harness did not plan was
reported stale and, with `--prune`, deleted. Those directories are shared
with installers the framework does not control — `npx skills add` and Agent
Plugins clients copy third-party skills straight into them, flat and
unnamespaced — which made every such skill a prune candidate, including the
framework's own catalog-distributed ones (RFC 0011).

The skills roots are now claimed per skill directory: the ones the harness
ships, plus a `RETIRED_CANONICAL_SKILLS` list of names it used to ship, so a
skill that leaves the canonical set is still cleaned up. Anything else under
those roots is never entered, listed, or deleted. Rules roots and the
`guren-*` native rules are unchanged. The change can only delete less than
before; a user who relied on `--prune` to clear third-party skills now
removes those by hand.
