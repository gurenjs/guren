---
'@guren/cli': minor
---

The agent harness ships a `plan-write` skill: the agent runs `guren plan "<request>" --print-prompt`, asks the person what the prompt leaves open before writing the plan, checks it with `plan:render --json`, and records review changes with `plan:revise`, leaving approval to the person and implementation to `plan-implement`. The harness entry document lists the three writing commands, and an existing app picks the skill up with `bunx guren agent:sync`.
