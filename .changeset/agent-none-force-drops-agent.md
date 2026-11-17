---
'@guren/cli': patch
---

`guren add browser-tests --behaviours --agent none --force` on an app set up for an agent now leaves no agent step behind. `browser:map` writes an agent step only while `e2e.browser.config.ts` imports an executor from `@e2e-dev/acp` and the app declares that package, so the regenerated behaviour specs skip those tests, naming why, instead of failing the run with `MODEL_UNAVAILABLE`. Switching to `none` also removes `@e2e-dev/acp` and the agents' adapters (`--no-install` prints the `bun remove` command). The command no longer asks you to set `BROWSER_TEST_PASSWORD` when `.env` or the shell already gives it a value.
