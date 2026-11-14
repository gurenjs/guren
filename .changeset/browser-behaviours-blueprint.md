---
"@guren/cli": minor
---

`guren add browser-tests --behaviours --agent claude-code` sets up the behaviour specs of RFC 0033 §13: `e2e.browser.config.ts`, which starts the app through `guren browser:serve` on port 4319 and runs each step under your Claude Code login; `tests/browser/behaviours/given.ts`; a sign-in setup where the app signs in with a password; the `test:behaviours` and `test:behaviours:ci` scripts; and the e2e runner at the exact versions this release was measured on (`e2e` 0.23.1, `@e2e-dev/web` 0.16.0, `@e2e-dev/acp` 0.1.2). `guren browser:map` writes the specs from then on. Commit `.e2e/cache/`: a recorded step replays in CI with no login and no model call. `--agent codex` is refused until it has been measured.
