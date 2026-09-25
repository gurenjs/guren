---
'@guren/server': patch
'@guren/cli': patch
'@guren/testing': patch
---

`createForceHttpsMiddleware()` no longer redirects an agent tool call. A tool call re-enters the app through `app.fetch` on the origin its caller reached: `http://` for an MCP endpoint behind a TLS-terminating proxy, and `http://localhost` for durable agents, `guren tool:call`, `TestApp.agent()` and in-process AI agents with no `APP_URL`. The middleware answered it with a 301, which the dispatcher reports as a successful result reading `HTTP 301 (Location: https://…)`, so in such an app every tool call returned that line instead of running.

The middleware now lets through only the `Request` object `buildToolRequest()` built in this process, matched by object identity. A request off the wire, or a copy of a dispatched one, is still redirected whatever headers it sends, `X-Guren-Agent-Surface` included. `guren tool:call` and `TestApp.agent()` now dispatch that object instead of a copy, and `guren tool:call` fetches its CSRF token on `https://localhost/`, which force-https serves rather than redirects.
