---
'@guren/cli': minor
---

`guren plan:next`, `plan:verify` and `plan:waive` refuse a plan that carries a baseline when no approval beside it names its current hash (RFC 0030 §4): a plan edited after it was approved, or one nobody approved. The refusal names the hash and says to run `guren plan:approve`. An approvals file that will not read refuses too. Drafts keep their behaviour, and `plan:waive --remove` still withdraws a waiver whatever the plan says. The Stop hook no longer verifies such a plan: it lets the stop through and records the step as stalled, which `plan:next` reports once the plan is approved. `plan:status` reports `approval` (approved, unapproved or unreadable) for a plan with a baseline and still exits 0. `plan:close` refuses through the same check.
