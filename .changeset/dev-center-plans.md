---
'@guren/cli': minor
'@guren/server': minor
---

The Dev Center at `/_guren` opens on the open implementation plans, those waiting on a person first (a draft to approve, a plan edited after approval, a stalled step, a plan ready to close), and `/_guren/plans/<slug>` shows one plan's steps with their last `plan:verify` outcome, the marked step, waivers and the commands that come next. `plan:next` and `plan:verify` print that path (and carry it as `devCenter` in `--json`), `guren_get_plans` gives each plan its `slug`, and the plan skills tell agents to hand it to the person at each decision. The server mounts `/_guren/plans.json` and `/_guren/plans/:slug` behind the same `GUREN_MCP=1` opt-in and loopback guard as the rest of the Dev Center.
