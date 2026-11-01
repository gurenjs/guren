---
'@guren/server': patch
---

A token whose abilities are all `tool:` / `tools:` scopes no longer authenticates ordinary routes. Such a token, the kind `guren token:issue --tools` mints for MCP clients, used to pass the token guard `useTokens()` registers and `createBearerTokenMiddleware` on every route, where no tool scope is checked, so a token issued for a few read tools could delete records. It now authenticates only the tool calls the agent pipeline dispatches after judging its scopes, and requests to the MCP endpoint, which judges them itself (so app-wide authentication middleware in front of it still lets an MCP client through); a token that also carries an ordinary ability, or `['*']`, is unchanged. In tests, call an agent tool as a user with `app.agent().call(name, args, { as: user })`; a tools-only bearer set through `withHeaders()` on that bridge is now refused like any direct request.
