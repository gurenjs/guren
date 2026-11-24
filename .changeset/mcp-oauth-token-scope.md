---
'@guren/plugin-cloudflare': patch
---

An access token from a `--mcp-oauth` worker now calls only the tools its own `scope` names. `@cloudflare/workers-oauth-provider` hands the MCP endpoint the props stored with a token, never the token's scope, and those props were the grant's from consent, so a token a client narrowed with `scope` on the code exchange or a refresh still called every tool of its grant, destructive ones included. The generated `OAuthProvider` now has a `tokenExchangeCallback` that limits a narrowed token's props to the entries its scope keeps, leaving the grant itself as consented.

A token request that sends no `scope`, as the MCP SDK's does, is unaffected. One that sends a scope the grant does not hold as written, such as the advertised `tools:read` against a grant of `tool:<name>` entries, now gets a token that calls nothing, which its empty `scope` in the token response already said. Re-run `bunx guren cloudflare:build --mcp-oauth` to take the fix; access tokens issued before it keep their props until they expire.
