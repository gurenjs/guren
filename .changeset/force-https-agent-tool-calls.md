---
'@guren/server': patch
---

`createForceHttpsMiddleware()` no longer redirects an agent tool call. A tool call re-enters the app through `app.fetch` on the origin its caller reached. That is `http://` for an MCP endpoint behind a TLS-terminating proxy, and always `http://localhost` for durable agents and `guren tool:call`. The middleware answered it with a 301, which the dispatcher reports as a successful result reading `HTTP 301 (Location: https://…)`, so every tool call in such an app returned that line instead of running. The middleware now lets through only the `Request` object `buildToolRequest()` built in this process, matched by object identity. A request off the wire, or a copy of a dispatched one, is still redirected, whatever headers it sends (`X-Guren-Agent-Surface` included).
