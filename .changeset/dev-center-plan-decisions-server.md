---
"@guren/server": minor
---

Mount the Dev Center's decision checks, `/_guren/plans/<slug>/readiness/<decision>`, behind the same `GUREN_MCP=1` opt-in and loopback guard as the other Dev Center routes. An app needs this `@guren/server` and a `@guren/cli` that answers the route for the plan page's **Check plan:approve**, **Check plan:close** and **Waive an element** buttons.
