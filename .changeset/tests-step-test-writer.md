---
'@guren/cli': minor
---

`plan-implement` hands a plan's tests step to the `test-writer` agent where the harness has one (RFC 0040 §5, Open Question 9): once `plan:scaffold` has written the skeleton, the agent fills in the test bodies from the plan step alone, leaves them failing, and the session runs `plan:verify` itself. The `test-writer` agent gains the rules for that step. Run `bunx guren agent:sync` to install it.
