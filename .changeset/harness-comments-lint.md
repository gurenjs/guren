---
"@guren/cli": minor
---

Agent harness: a `comments.md` rule (what a comment may carry, the 5/8-line limits, the `oxlint-disable-next-line` escape), a Comments section in the `code-review` subagent's checklist, and a `check-after-edit` hook that also runs oxlint on the edited file when the app has an `.oxlintrc.json` (`bunx guren add lint`), reporting warnings as well as errors back to the agent. Refresh an installed harness with `bunx guren agent:sync`.
