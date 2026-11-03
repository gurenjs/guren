---
"@guren/cli": patch
---

The Claude Code edit hook (`.claude/hooks/check-after-edit.ts`) no longer reports its `guren check` and oxlint findings as a blocking hook error. It exits 0 and hands them to the agent as `additionalContext` beside the edit's result, since a change that spans several files passes through states the checks flag; the `Stop` hook's `guren gate` still blocks. It also skips a file git ignores. Run `bunx guren agent:sync` to pick it up.
