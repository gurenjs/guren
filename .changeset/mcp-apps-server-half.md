---
'@guren/server': minor
'@guren/core': patch
'@guren/plugin-mcp': minor
'@guren/cli': minor
---

MCP Apps, the server half (RFC 0038 Phase 1). A route can name the Inertia page an MCP Apps host should render its tool result with: `.agent({ ui: pages.posts.Show })`, or `.agent({ ui: { visibility: ['app'] } })` for a write only a view calls. `deriveAgentTools()` carries it as `DerivedAgentTool.ui`, and leaves out a tool whose `ui` is malformed rather than dropping `ui`, which would show an app-only tool to the model. `.guren/agents.gen.ts` renders `ui` and, when some tool names a page, `agentUiPages`.

`@guren/plugin-mcp` takes the built pages as a module (`mcpPlugin({ ui: { pages: () => import('@/.guren/mcp-app/index.gen') } })`, the build itself lands in Phase 2) and, when a tool declares `ui`, advertises `resources` and the `io.modelcontextprotocol/ui` extension, writes `_meta.ui` on the tool in `tools/list`, and serves `ui://<server>/pages/<page>?v=<hash>` and a per-caller bridge catalogue through `resources/list` and `resources/read`, filtered like `tools/list`. A page with no build loses its URI and keeps its visibility. Every route tool's result now carries `_meta["dev.guren/response"]` (`executed`, `denied` with the approval request, or `failed`), and a `ui` tool's Inertia result `_meta["dev.guren/inertia-page"]`.

An App MCP tool call now carries only the shared Inertia props named in `mcpPlugin({ ui: { sharedProps: [...] } })`, default none, in its text as in a view: `auth.user`, flash messages and the translation catalogue no longer reach the model unless the app lists them. An app that relied on one in a tool's text lists it there. Browser requests are unchanged.

`guren check` adds `agent-route-ui-page` and `agent-route-ui-shape` (fail), `agent-route-ui-output` (fail, `ui.page` with an `output` schema), and `agent-route-ui-renders`, `agent-route-ui-deferred`, `agent-route-ui-visibility` and `agent-route-ui-pages-module` (warn).
