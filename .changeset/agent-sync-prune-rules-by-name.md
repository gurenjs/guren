---
'@guren/cli': patch
---

fix(cli): `agent:sync --prune` no longer deletes project-authored files in the rules roots

`.claude/rules/` and `.agents/rules/` were claimed as whole directories, so
`--prune` removed any file there the current harness does not ship — including
the project's own conventions file, which is exactly what the same command's
output tells you to keep ("keep project-specific rules in files of your own").
The claim is now per rule filename, the way skills have been claimed since
v2.9.0: only the rule files the harness ships, plus the ones recorded in
`RETIRED_CANONICAL_RULES`, are reported or removed. A rule file of your own,
including one in a subdirectory, is left alone and no longer listed at all.

Renamed canonical rules still get cleaned up: the native `guren-*` copies by
their prefix, and the canonical roots' copies once the old filename is recorded
as retired.
