# @guren/plugin-webmcp

> **Experimental.** WebMCP is a [W3C Community Group draft](https://github.com/webmachinelearning/webmcp).
> Its API has already moved once (`navigator.modelContext` → `document.modelContext`)
> and will move again. This package tracks the draft and may break in a minor.

Registers your application's agent tools on the browser's `modelContext` API, so
an in-page AI agent calls them **as the signed-in user** — same session cookie,
same CSRF token, same policies, same validation.

Nothing is written twice. The tools come from `.guren/agents.gen.ts`, which
`guren codegen` derives from the routes that declare `.agent()` metadata
(RFC 0016). A tool call is turned back into the HTTP request its route already
validates.

## Install

```bash
bunx guren plugin @guren/plugin-webmcp
```

## Client

```tsx
// resources/js/app.tsx
import { agentTools } from '@/.guren/agents.gen'
import { registerAgentTools } from '@guren/plugin-webmcp/client'

await registerAgentTools(agentTools)
```

`registerAgentTools` never throws for a browser that lacks the API — it returns
`{ supported: false }`, because a missing experimental API is the normal case on
most page loads, not an error. It does throw if a *registration* fails (a
duplicate tool name, a schema the host rejects): that is a wiring mistake you
need to see, and the tools already registered are removed first.

```ts
const registration = await registerAgentTools(agentTools)

registration.supported   // false on a browser without modelContext
registration.registered  // ['posts.index', 'posts.store']
registration.skipped     // [{ tool: 'payouts.store', reason: 'approval' }]
await registration.unregister()
```

### What gets registered

| Tool | Registered? |
|---|---|
| `expose.webMcp` is false (`.agent({ expose: { webMcp: false } })`) | No |
| `approval: 'required'` | No, unless you pass `includeApprovalRequired: true` |
| everything else marked `.agent()` | Yes |

> **`expose.webMcp` defaults to true.** One `registerAgentTools(agentTools)` line
> therefore puts your *entire* `.agent()` catalog on the page. That is the intent
> — the catalog is already opt-in per route — but it makes adopting this plugin a
> single decision about every agent route at once. Review the list with
> `bunx guren tool:list` first, and mark anything that should not be reachable
> from a browser tab with `.agent({ expose: { webMcp: false } })`.

Approval-gated tools are skipped by default on purpose. The server-side approval
queue is reached through the App MCP endpoint (`@guren/plugin-mcp`); WebMCP has
no equivalent, so registering such a tool here would offer an agent a call your
application asked a human to confirm. Turn the option on only if the page itself
confirms them.

### Options

```ts
await registerAgentTools(agentTools, {
  includeApprovalRequired: false, // default
  modelContext: myShim,           // override anchor detection
  fetch: myFetch,                 // override the dispatching fetch
})
```

## How this differs from the App MCP endpoint

Both surfaces serve the same derived tools, but they are not equivalent, and the
gaps are deliberate rather than pending work.

**No audit trail.** A WebMCP call is an ordinary same-origin `fetch` from your
page. Nothing emits `AgentToolInvoked` / `AgentToolDenied` for it, because no
server-side adapter sits in the path. The `X-Guren-Agent-Surface: webmcp` header
the request carries is informational and set by the client, so an audit keyed on
it would be suppressible by the caller it claims to record. Your ordinary HTTP
request logging covers these calls like any other browser request.

**No scope filtering.** App MCP filters its catalog to a bearer token's scopes. A
session has no scopes, so the in-page agent sees every `expose.webMcp` tool at
the signed-in user's full authority. Your policies still gate execution —
exposure is not permission — but on this surface `expose.webMcp` is the whole
exposure decision.

**Redirects are not followed.** See
[How a call reaches your route](#how-a-call-reaches-your-route) below.

## Server

```ts
// src/app.ts
import { createApp } from '@guren/core'
import { webMcpPlugin } from '@guren/plugin-webmcp'

export default createApp({
  providers: [webMcpPlugin()],
})
```

The server half does almost nothing, and that is the design: WebMCP runs in the
page. It exists so the app can serve a Chrome **origin trial** token, which only
the server can do:

```ts
webMcpPlugin({ originTrial: process.env.WEBMCP_ORIGIN_TRIAL })
```

The token is appended to the `Origin-Trial` response header, so it sits beside
any other trial your app already serves rather than replacing it.

## Browser requirements

- **A secure context.** `modelContext` is unavailable over plain HTTP, apart
  from `localhost`. In development that means `localhost`; in production, HTTPS.
- **The `tools` permissions policy.** A cross-origin iframe needs
  `allow="tools"` before the API is exposed inside it.
- **The origin trial**, or the browser flag, while the API is pre-release.

## How a call reaches your route

1. The agent calls a tool with one flat argument object.
2. The manifest's `inputSources` says which contract each argument came from, so
   `params` substitute into the path, `query` keys join the query string, and
   `body` keys become the JSON body — exactly where `validateParams`,
   `validateQuery` and `validateBody` look for them.
3. For an unsafe method the `XSRF-TOKEN` cookie is copied into `X-XSRF-TOKEN`,
   the header Guren's CSRF middleware reads.
4. The request goes out with `mode: 'same-origin'` and `redirect: 'manual'`,
   carrying the page's cookies and `X-Guren-Agent-Surface: webmcp`.
5. The response becomes an MCP tool result: `structuredContent` when the route
   binds an `output` schema, `isError` for a 4xx/5xx carrying the body your
   exception handler produced.

**Redirects are refused, not followed.** A tool call carries the session
cookie's authority *and* the CSRF token header, and `fetch` strips only
`Authorization` across a cross-origin redirect — so a single open redirect
anywhere in your app could replay the request body and the token to another
host. A route that answers with a 3xx therefore reports that the client did not
follow it; the target is not readable from the page. If a tool needs to redirect,
give the route a JSON response for the agent instead.

Your route's authorization is what authorizes the call. The MCP `annotations` in
the manifest are hints for client UX and enforce nothing. They are passed to the
browser unchanged: WebIDL conversion ignores dictionary members a host does not
know, so a host understanding fewer annotations drops the rest rather than
rejecting the tool. `untrustedContentHint` is not sent — nothing in a route
contract says whether a response embeds third-party content, so it is not
derivable yet; set it yourself if you wrap `registerAgentTools`.

## License

MIT
