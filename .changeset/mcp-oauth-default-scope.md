---
"@guren/plugin-cloudflare": patch
---

Offer a default scope when an OAuth client sends none, and advertise the scopes it could ask for

An `--mcp-oauth` worker's consent screen offered exactly what the authorize
request asked for, so a client sending no `scope` was offered nothing: the page
said there was nothing to approve, the user had no button to press, and the MCP
connection could not be established at all. Both clients measured against a
deployed app (Claude's connector and MCP Inspector) omit `scope` and expose no
field to add one, so there was no way round it from the client. RFC 6749 §3.3
requires a server receiving no scope to apply a default or fail the request.

The scaffolded `McpOAuthController` now substitutes `DEFAULT_SCOPE`, a named
constant set to `tools:*`, when the request carries no scope at all. That widens
the offer, not the grant: the screen renders write tools unticked, so approving
it untouched still grants only the read-only set, and the intersection against
the client's request is unchanged. A scope that is present but expands to
nothing still offers nothing, so a client naming one unknown tool is not handed
every tool.

The generated `OAuthProvider` also declares `scopesSupported: ['tools:*',
'tools:read']`, which the authorization server metadata advertises, so a client
that reads it has something to request. Only the set-level scopes are listed:
the build has no route graph, so the `tool:<name>` scopes an app exposes are not
known at build time.

An app that already ran `--mcp-oauth` gets the metadata half from a rebuild, since
the worker is regenerated every build, but not the default: the scaffold never
overwrites a controller the developer already has. Apply it by hand in
`app/Http/Controllers/McpOAuthController.ts`:

```ts
const DEFAULT_SCOPE = 'tools:*'

// in offeredTools(), where `requested` was passed straight to expandToolScopes:
requested.length > 0 ? requested : [DEFAULT_SCOPE],
```
