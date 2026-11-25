---
'@guren/server': patch
---

A path declared with `declareCookielessAuthPath()` (the MCP endpoint's, for example) is no longer exempt from CSRF verification on a request that an app route registered through the router answers first. A pattern route such as `router.post('/:slug', …)` matches `/mcp` and is registered ahead of the endpoint, so it used to run with CSRF skipped; that request is now verified like any other. Requests the declaring endpoint answers keep the exemption when that endpoint is mounted on Hono directly, as `plugin-mcp` mounts its own (an endpoint mounted through the router is itself a router route, so it is verified), including when a pass-through middleware added straight to Hono, such as `hono.post('*', …)`, sits in front of it. A route added straight to `app.hono` ahead of the endpoint is not detected.
