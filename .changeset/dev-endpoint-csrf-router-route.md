---
'@guren/server': patch
---

Under `GUREN_MCP=1`, the dev MCP endpoint (`/_guren/mcp`) and the Dev Center write routes are no longer exempt from CSRF verification on a request that an app route registered through the router answers first. These endpoints mount after the app's routes, so a pattern route such as `router.post('/:a/:b', …)` matched `/_guren/mcp` and ran with CSRF skipped; that request is now verified like any other. Requests the endpoints answer themselves keep the exemption, and a route added straight to `app.hono` ahead of them is not detected.
