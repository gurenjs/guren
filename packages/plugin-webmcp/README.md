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
4. The request goes out same-origin with the page's cookies, and
   `X-Guren-Agent-Surface: webmcp`.
5. The response becomes an MCP tool result: `structuredContent` when the route
   binds an `output` schema, `isError` for a 4xx/5xx carrying the body your
   exception handler produced.

Your route's authorization is what authorizes the call. The MCP `annotations` in
the manifest are hints for client UX and enforce nothing.

## License

MIT
