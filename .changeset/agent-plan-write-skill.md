---
'@guren/cli': minor
---

The agent harness ships a `plan-write` skill for writing an implementation plan in the session where the feature is discussed. The agent decides whether the change needs a plan, asks the questions that change the design before writing any JSON, writes `docs/plans/<slug>/plan.json` from `guren plan "<request>" --print-prompt`, and runs `plan:render --json` until no check fails. It then reports the page, the open questions and the warnings it left. After a review it records the person's changes and the page's exported feedback with `plan:revise`. It never runs `plan:approve`, and hands an approved plan to the `plan-implement` skill. The harness entry document now lists `plan --print-prompt`, `plan:render --json` and `plan:revise` beside the implementation commands, and `plan-implement` names `plan:revise` wherever a design change was an edit of the plan. An existing app picks the skill up with `bunx guren agent:sync`.
