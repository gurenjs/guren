---
"@guren/cli": patch
---

The `verify-in-browser` skill of the agent harness covers behaviour specs: when the app has `e2e.browser.config.ts`, it tells the agent to run `bun run test:behaviours` after changing a page, to commit a recording that was made again, and to report a failing test as a finding without editing a recording, a generated spec or the plan. Run `bunx guren agent:sync` to take it.
