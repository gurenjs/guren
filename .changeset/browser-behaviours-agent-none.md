---
"@guren/cli": minor
---

`guren add browser-tests --behaviours --agent none` sets up the behaviour specs with no agent: `e2e.browser.config.ts` has no `agents` entry, and only `e2e` and `@e2e-dev/web` are installed. `browser:map` writes each behaviour the plan names every control of as locator steps, which need no login and no recording, and a behaviour that needs an agent step (in any app that declares no `@e2e-dev/acp`) is a skipped test naming why. Run the command again with `--agent claude-code` or `--agent codex` and `--force` to add an agent later.
