---
"@guren/cli": minor
---

Add `guren plan:next <plan> [--app <dir>] [--json]` (RFC 0030 §7), the front of
the implementation loop: the first step in task order whose record under
`.guren/plans/` does not stand, printed with the elements it completes, the
acceptance behaviours it writes or must see pass, and its verify commands, never
the whole plan. It runs nothing and loads no application. It refuses a working
tree with uncommitted changes unless they are the marked step's own, since one
step is one commit, and it marks the step in the state file
(`active: { plan, step, startedAt, continuations }`), clearing the mark once every
step is verified. The `.gitignore` written beside the state now ignores itself,
so a verify leaves the tree as clean as it found it.

The harness Stop hook (`gate-on-stop.ts`, delivered by `agent:sync`) now verifies
the marked step after the gate, on every stop, and blocks the stop while the step
is not verified: up to three continuations, then it gives up and says why. It
gives up at once when the step or an element it owns is `blocked` (the
environment's verdict), and on a stop that follows a blocked one when nothing
about the step's record changed. The stall is recorded on the mark with the
reason and the last output, and sticks until the next `plan:next` reports it and
returns the step again with a fresh mark. Cursor gets the findings as a follow-up
message, bounded by its `loop_count`, and a stall on stderr.

The harness gains the `plan-implement` skill: `plan:next` → implement exactly
that step → `plan:verify --step` → one commit, with what each step kind asks
for, what a stall means, and the `code-review` subagent at the end of a task.
`planStopHookFindings()` and `MAX_STEP_CONTINUATIONS` are exported for the hooks.
