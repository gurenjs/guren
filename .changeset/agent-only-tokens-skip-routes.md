---
'@guren/server': minor
'@guren/plugin-mcp': patch
'@guren/cli': patch
---

A token whose abilities are all `tool:` / `tools:` scopes no longer authenticates ordinary routes. Such a token, the kind `guren token:issue --tools` mints for MCP clients, used to pass the token guard `useTokens()` registers and `createBearerTokenMiddleware` on every route, where no tool scope is checked, so a token issued for a few read tools could delete records. It now authenticates only the tool calls the agent pipeline dispatches after judging its scopes, and requests to an endpoint declared with the new `Application.declareAgentEndpoint(path)`, which plugin-mcp calls for its own endpoint since it judges the scopes itself (so app-wide authentication middleware in front of it still lets an MCP client through); a token that also carries an ordinary ability, or `['*']`, is unchanged. In tests, call an agent tool as a user with `app.agent().call(name, args, { as: user })`; a tools-only bearer set through `withHeaders()` on that bridge is now refused like any direct request. `guren tool:dev` now reports a missing endpoint from those declared paths.
