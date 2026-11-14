---
"@guren/cli": patch
---

The `verify-in-browser` skill of the agent harness runs the app's browser tests in a section of their own, ahead of the recorded steps: `bun run test:browser`, and `bun run test:behaviours` when the app has `e2e.browser.config.ts`. They start their own instance, so an `inconclusive` result from `browser:doctor` no longer keeps an agent from running them. For behaviour specs the skill says to commit a recording that was made again, to report a failing test as a finding without editing a recording, a generated spec or the plan, and to leave the recordings a failed run changed uncommitted. Run `bunx guren agent:sync` to take it.
