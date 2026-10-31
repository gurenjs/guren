---
'@guren/cli': minor
'@guren/server': minor
---

Review a plan in the Dev Center. **Review this plan** on `/_guren/plans/<slug>` opens `/_guren/plans/<slug>/review`, the page `plan:render` wrote, served so each verdict, comment and answer is saved to `.guren/plans/<slug>.feedback.json` (stamped with the plan's digest) as it is made, and loaded again on the next visit. `plan:revise` applies that file when `--feedback` is omitted, only while it names the plan as it stands, `guren_get_plans` and the Dev Center report it, and the `plan-write` skill reads the comments from it, so the person no longer pastes the page's JSON. The server mounts the review behind `GUREN_MCP=1` and the loopback guard; `/_guren/plans/<slug>/feedback` is the Dev Center's one write route, exempt from the CSRF token on the MCP endpoint's terms, and the CLI checks its `Origin`, schema and plan digest. Approval stays `plan:approve`.
