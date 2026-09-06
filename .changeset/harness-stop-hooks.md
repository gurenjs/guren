---
'@guren/cli': minor
---

Stop hooks for Cursor and Codex, and `stopGateFindings`

`agent:init --target cursor` writes `.cursor/hooks.json` and
`.cursor/hooks/gate-on-stop.ts`; `--target codex` writes `.codex/hooks.json`
and `.codex/hooks/gate-on-stop.ts`. Both run `guren gate` when a turn ends
with uncommitted changes and feed a failing stage's findings back into the
turn: Cursor as an automatic follow-up message (bounded by `loop_limit`),
Codex by blocking the stop once, the same contract as the Claude Code hook
(Codex runs hooks in the session cwd, so its config finds the app's `.codex/`
upward from there, and runs a project hook only after `/hooks` trusts it).
Every hook gates the app it is installed in, which a monorepo app makes
distinct from the git root. A host that loads `.claude/settings.json` without
speaking its contract (Cursor's third-party setting) is left to its own hook,
so the gate runs once. `agent:sync` now detects a Codex install by its managed
hook and refreshes it.

`.claude/settings.json` is merge-hinted like the MCP configs: an app whose
settings predate the stop hook is shown the snippet to add.
The hook configs are user-owned like the MCP configs: an existing file is
left alone and the snippet to merge is printed. Copilot and OpenCode have no
turn-end hook that can feed output back, so they stay on the `AGENTS.md`
instruction to run the gate themselves.

`stopGateFindings(cwd)` is the shared verdict behind every stop hook: `null`
when the tree is clean or the gate passes, else the failures as text.
