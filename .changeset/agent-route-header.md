---
'@guren/server': patch
'@guren/plugin-webmcp': patch
---

A WebMCP tool call can no longer run a different route by passing a path argument equal to an earlier route's literal segment, such as `{ id: 'all' }` on `DELETE /notifications/:id` behind `DELETE /notifications/all`. `buildToolRequest` now sends `X-Guren-Agent-Route` naming the tool's route, and when a request without the in-process mark reaches a route that matches it on neither name nor method and path (parameter labels aside), the router answers 400 with `Cache-Control: no-store` and runs nothing. A page built before a deploy keeps working: a renamed parameter, a changed constraint or a renamed route still matches on the other half, Hono middleware whose path covers the tool's still runs, and a header naming no route the app registers is let through. In-process calls (App MCP, the agent pipeline) are judged exactly as before.
