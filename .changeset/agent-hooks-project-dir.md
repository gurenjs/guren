---
'@guren/cli': patch
---

The Claude Code hooks in the agent harness now run from the project directory rather than from wherever the agent last `cd`-ed. Claude Code runs a hook command in the session's current directory, which moves with the agent's `cd`, so `bun .claude/hooks/check-after-edit.ts` failed with `Module not found` as soon as the agent worked inside `modules/foo`, and the edit check and the stop gate were silently skipped. `.claude/settings.json` now anchors every command to `${CLAUDE_PROJECT_DIR}`, and the two hook scripts judge paths from the app root instead of the cwd. The app root is the nearest ancestor holding the same hook script: of the edited file for the edit check, of the hook input's `cwd` for the stop gate. A worktree Claude Code entered mid-session (where `${CLAUDE_PROJECT_DIR}` stays at the original checkout) is therefore still the tree that gets checked and gated, as long as the worktree carries the hook scripts, which it does when `.claude/hooks/` is committed.

`.claude/settings.json` is user-owned, so `bunx guren agent:sync` refreshes the hook scripts but never rewrites that file. It now detects the old commands and prints each one with its replacement. To fix an existing app by hand, change the three `"command"` values in `.claude/settings.json`:

- `"bunx guren context 2>/dev/null || true"` to `"cd \"${CLAUDE_PROJECT_DIR}\" && bunx guren context 2>/dev/null || true"`
- `"bun .claude/hooks/check-after-edit.ts"` to `"bun \"${CLAUDE_PROJECT_DIR}/.claude/hooks/check-after-edit.ts\""`
- `"bun .claude/hooks/gate-on-stop.ts"` to `"bun \"${CLAUDE_PROJECT_DIR}/.claude/hooks/gate-on-stop.ts\""`

Run `bunx guren agent:sync` as well, so the hook scripts pick up the new root rule. The Cursor and Codex hooks are unchanged: Cursor runs project hooks from the project root, and the Codex command already looks for `.codex/` upward from its cwd.
