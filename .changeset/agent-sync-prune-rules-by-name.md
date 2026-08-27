---
'@guren/cli': patch
---

fix(cli): `agent:sync --prune` no longer deletes rules files your project wrote

`.claude/rules/` and `.agents/rules/` were claimed as whole directories, so
`--prune` removed any file there the current harness does not ship — including
the project's own conventions file, which is exactly what the same command's
output tells you to keep ("keep project-specific rules in files of your own").

The claim is now by rule filename, the way skills have been claimed since
v2.9.0: only the rule files the harness ships, plus the filenames earlier
harness versions shipped, are reported or removed. A rules file of your own,
including one in a subdirectory, is left alone and no longer listed at all.

Renamed framework rules are still cleaned up: the native `guren-*` copies by
their prefix, and the copies in the canonical roots under the names past
releases wrote.
