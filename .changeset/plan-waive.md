---
'@guren/cli': minor
---

`guren plan:waive <plan> <element-id>... --reason "<text>"` accepts elements of an approved plan incomplete (RFC 0030 §6). The waiver goes into a decision log beside the plan, committed with it: `decisions.json` next to a `docs/plans/<slug>/plan.json`, `<slug>.decisions.json` next to any other plan. It names the plan's hash, so a revision inherits none of them. `plan:status` reports a waived element as `waived` unless its step already verified it, `plan:verify` leaves it out of the step's judgement, and the implementation loop moves past a stall that a person has accepted. `--remove` deletes a waiver, and the step that rested on it is verified again rather than skipped.
