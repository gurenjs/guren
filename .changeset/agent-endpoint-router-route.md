---
'@guren/server': patch
---

A tools-only token (one granting only `tool:` / `tools:` abilities) no longer authenticates a request to a path declared with `declareAgentEndpoint()` when an app route registered through the router answers that request first. A pattern route such as `router.post('/:slug', …)` matches `/mcp` and is mounted ahead of the endpoint, so it used to accept the token while checking no tool scope; the bearer middleware and the token guard now refuse it there, as they do on any other route. Requests the declared endpoint answers keep accepting the token when the endpoint is mounted on Hono directly, as `plugin-mcp` mounts its own; an endpoint mounted through the router is itself a router route, so it no longer accepts the token. A route added straight to `app.hono` ahead of the endpoint is not detected.
