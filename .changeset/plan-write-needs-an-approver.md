---
"@guren/cli": patch
---

The agent harness no longer sends a session nobody approves from into the plan loop. The `plan-write` skill now checks first whether a person will approve the plan before it is built; in a headless `claude -p` run, a scheduled job, or a request that says nobody will review, it writes no plan and builds the change directly with the ordinary workflow. It still never runs `plan:approve`. Run `bunx guren agent:sync` to pick up the skill.
