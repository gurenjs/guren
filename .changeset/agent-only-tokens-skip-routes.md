---
'@guren/server': patch
---

A token whose abilities are all `tool:` / `tools:` scopes no longer authenticates ordinary routes. Such a token, the kind `guren token:issue --tools` mints for MCP clients, used to pass the token guard `useTokens()` registers and `createBearerTokenMiddleware` on every route, where no tool scope is checked, so a token issued for a few read tools could delete records. It now authenticates only the tool calls the agent pipeline dispatches after judging its scopes; a token that also carries an ordinary ability, or `['*']`, is unchanged.
