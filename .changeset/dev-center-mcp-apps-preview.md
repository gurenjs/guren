---
'@guren/cli': minor
'@guren/server': minor
---

The Dev Center gains an MCP Apps preview at `/_guren/mcp-apps` (RFC 0038 §8). Paste a token from `guren token:issue`, and the page lists the tools whose `.agent({ ui })` view the token can see, calls one through the app's own App MCP endpoint, and renders its view the way a web host does: through a sandbox proxy on another origin, under the view's declared CSP, with every message between the host and the view listed beside it. The token stays in the page's memory and goes only to the endpoint on the page's origin.

The proxy is served at `/_guren/mcp-apps/sandbox` on `127.0.0.1` for a Dev Center opened on `localhost` at the same port, and refuses every other host, so the two can never share an origin; on any other host the page says to open it on `localhost`. A link the view asks to open and a message it drafts for the conversation are listed, never opened or sent. `@guren/server` mounts both paths behind the Dev MCP endpoint's guard; an older `@guren/cli` answers them 404. That second origin is the app's own, so the proxy isolates a view from the Dev Center page and its token, not from the app, and drops this machine's hosts (`localhost`, `127.x`, `0.0.0.0`) from the view's declared CSP: a view that only works by calling the dev server would fail in a real host.
