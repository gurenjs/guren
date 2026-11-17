---
'@guren/cli': patch
---

`guren add browser-tests --behaviours --agent codex --force` on an app set up for Claude Code (or the other way round) now removes the previous agent's adapter, which the rewritten config no longer starts (`--no-install` prints the `bun remove` command). A config kept without `--force` still imports the previous agent, so its adapter stays. The `BROWSER_TEST_PASSWORD` check reads the env files the Playwright config loads (`.env.local`, `.env.<NODE_ENV>`, `.env`, the first that assigns it winning), so a password kept only in `.env.local` no longer brings the reminder to set it.
