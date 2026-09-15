---
'@guren/cli': patch
'@guren/server': patch
'@guren/core': patch
---

Follow-up cleanups to the Dev MCP move (RFC 0028 step 2), from a review of the merged change.

- `@guren/cli` loads the MCP SDK on the first Dev MCP request instead of at import. The package index re-exports `createDevMcpHandler`, so a static import put the SDK in the graph of every consumer of the index (the scaffolded edit hook, `deploy-check`, `create-app`) for a measured 33-43 ms none of them use.
- The Dev MCP server is typed against the CLI's own `ProjectContext`, `EntityContext`, `CheckReport`, `DoctorReport`, `GateReport`, `ModelInfo`, `ContextRoute` and `ResourceDefinition` rather than a hand-copied interface, which removes the casts that were hiding drift, and takes `WriterOptions` where it had copied that shape. `guren_make_component` drops a `route` entry the input schema never admitted.
- `McpServiceProvider` declares the two-member CLI interface it actually calls instead of importing the deprecated `createMcpServer`'s 30-member one, and exports `devMcpUnavailableReason` for the old-CLI decision. `@guren/server/mcp`'s deprecated `GurenCliApi` is unchanged from its 2.23 shape again.
- `DevOnlyModule` entries name the package that imports them (`importedBy`), and core's module-graph check searches that package alone, with parsed imports rather than a line-based grep. It had been widened to three roots, where any root's import satisfied any entry.
