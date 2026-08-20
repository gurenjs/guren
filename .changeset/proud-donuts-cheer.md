---
"@guren/cli": minor
---

`guren agent:sync` no longer overwrites managed files silently. Files already matching the latest template are skipped and reported as up to date (line-ending-only differences count as up to date, so a CRLF checkout is not warned about forever); a file whose contents differed — an older version or a local edit — is listed as replaced, with a warning that local edits to framework-managed files do not survive a sync. A new `--dry-run` flag on both `agent:sync` and `agent:init` reports what a run would write, replace, or prune without changing any file; combined with `--prune` it says what would be removed, and the closing hint repeats the flags the preview ran with. `AgentHarnessResult` gains `replaced`, `unchanged`, and `dryRun` fields, and `written` now reports only the files actually written.
