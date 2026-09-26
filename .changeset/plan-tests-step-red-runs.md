---
"@guren/cli": patch
---

Keep a plan's `tests` step verifiable after a revision. A verified `tests:fail` run now records each behaviour as seen failing, keyed on its test as the plan states it (everything but the description), and a later `plan:verify` carries that record to a revised plan for every behaviour whose test the revision left alone, instead of asking an implemented behaviour to fail again. The Stop hook gives up at once on a `tests` step whose behaviours already pass with no such record, and `plan:next` marks a step verified against an earlier plan hash as one to re-check with `plan:verify` before implementing it.
