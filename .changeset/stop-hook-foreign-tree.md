---
'@guren/cli': patch
---

The Stop hook (`.claude/hooks/gate-on-stop.ts`, and `.codex/hooks/gate-on-stop.ts` for Codex) gates the nearest directory above the session cwd that holds a copy of the hook only when that directory is the app itself or the app's place in another worktree of its repository, as `git worktree list` reports it. Any other tree carrying the script is passed over and the app the hook is installed in is gated instead, so ending a turn inside a checkout the agent worked in no longer runs that checkout's `package.json` scripts and routes inside the trusted project's hook. A plain copy of the app that is not a git worktree, or (under Claude Code) an app holding its own harness inside the project's, is therefore no longer gated on its own tree. Run `bunx guren agent:sync` to pick it up.
