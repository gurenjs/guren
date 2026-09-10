---
"@guren/plugin-cloudflare": patch
---

Advertise the tool scope where a conforming MCP client actually reads it

The `--mcp-oauth` worker declares `scopesSupported`, which reaches only the RFC
8414 authorization server metadata. The MCP specification's scope selection
strategy does not read that document: a client takes the `scope` from the 401
`WWW-Authenticate` challenge, and failing that the `scopes_supported` of
Protected Resource Metadata (RFC 9728). Neither carried a value, so the
advertisement never reached the clients it was added for and they went on
sending no scope.

The generated worker now also sets `resourceMetadata.scopes_supported`, the one
option feeding both of those surfaces. It carries `tools:read` alone: a
conforming client requests everything the field lists, and the field is
specified to hold the minimum that basic functionality needs, so `tools:*` there
would have every client ask for the whole tool surface. `tools:*` stays in the
server metadata for anyone inspecting what the server accepts.

The consent screen's empty state now names the scope grammar and points at
`guren tool:list`, instead of only saying that nothing can be granted. It
deliberately does not echo the requested scopes back: `scope` is attacker-
reachable through the authorize URL, every word in it passes the RFC 6749 token
charset, and this is the one screen where a stranger's sentence would read as
the application's own.

A type test pins both option names against the provider's own declarations,
since the worker is emitted as a string and a rename would otherwise be silent.
