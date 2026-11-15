---
"@guren/cli": minor
---

`guren add browser-tests --behaviours` accepts `--agent codex`: the config runs each step under your Codex login through `@agentclientprotocol/codex-acp`. Measured on the same app as Claude Code: the behaviours recorded and replayed, and 52 steps run on the model passed with no `POLICY_DENIED`. A recording made under one agent replays under the other. To move an app from one agent to the other, run the command again with `--force`, which rewrites `e2e.browser.config.ts` and keeps `given.ts` and the recordings.
