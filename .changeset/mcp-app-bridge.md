---
'@guren/inertia-client': minor
---

`@guren/inertia-client/mcp-app` mounts an Inertia page inside an MCP Apps host (RFC 0038). `startMcpApp({ pages, setup })` connects to the host, waits for the tool result, mounts the page it carries, and answers each visit with a tool call through the host: a redirect is followed, a 422 lands on the current page as `errors`, a visit no tool answers opens the application in the browser, and a call waiting for approval holds the page until `useMcpApp().pendingApproval.resubmit()`. The view's visits are kept in memory, so they never become entries of the host's tab. `useMcpApp()` reports whether the page runs in a host, the host context and capabilities, and exposes `sendMessage()`, `updateModelContext()` and `openLink()`; in the ordinary app it reports `isMcpApp: false`.

The subpath loads `@modelcontextprotocol/ext-apps` (`^2.0.0`), an optional peer, only when `startMcpApp()` runs. An app that builds MCP App views installs it with its own peers: `bun add @modelcontextprotocol/ext-apps @modelcontextprotocol/client @modelcontextprotocol/core zod`.
