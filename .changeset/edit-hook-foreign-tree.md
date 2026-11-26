---
'@guren/cli': patch
---

The Claude Code edit hook (`.claude/hooks/check-after-edit.ts`) judges an edited file from the nearest directory holding a copy of the hook only when that directory is the app itself or the app's place in another worktree of its repository, as `git worktree list` reports it. Any other tree carrying the script is passed over, so an edit in a checkout the agent was allowed to change no longer imports that checkout's routes file or runs its oxlint inside the trusted project's hook. A plain copy of the app that is not a git worktree is therefore no longer checked from its own root: a file in it is judged from the app the hook is installed in, or not at all when it sits outside that app. Run `bunx guren agent:sync` to pick it up.
