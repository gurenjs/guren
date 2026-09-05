---
'@guren/plugin-mcp': patch
---

Answer `401` rather than a CSRF `403` when the App MCP endpoint is called
without a bearer token

In an app with sessions enabled, a token-less POST to the configured MCP path
was rejected by CSRF before the endpoint's own bearer check, reporting a token
mismatch for a request that had simply not authenticated. The endpoint now
declares its path as authenticating without cookies, which is true of both ways
in: a bearer token, and the in-process external-auth seam. It needs the
`@guren/core` release carrying `Application.declareCookielessAuthPath`, which is
the 1.14.0 already in the pending plan and already named by this package's
`gurenPlugin.compatibility`.
