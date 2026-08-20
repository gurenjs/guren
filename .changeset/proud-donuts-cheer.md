---
"@guren/cli": minor
---

`guren agent:sync` no longer overwrites managed files silently. Files already matching the latest template are skipped and reported as up to date; a file whose contents differed — an older version or a local edit — is listed as replaced, with a warning that local edits to framework-managed files do not survive a sync. A new `--dry-run` flag reports what a sync would write, replace, or prune without changing any file. `AgentHarnessResult` gains `replaced`, `unchanged`, and `dryRun` fields, and `written` now reports only the files actually written.
