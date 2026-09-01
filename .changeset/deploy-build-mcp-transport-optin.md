---
'@guren/core': minor
---

Add the App MCP build opt-in to `@guren/core/internal/deploy-build`: `appUsesMcpPlugin()` and `stubbableDevOnlyModules()`, plus the `MCP_PLUGIN_PACKAGE` and `MCP_TRANSPORT_SPECIFIER` constants they are stated in terms of.

The deploy plugins stub every entry of `DEV_ONLY_MODULES`, and one of those entries is the transport `@guren/plugin-mcp` dynamically imports — so an app that installed the plugin deployed an App MCP endpoint that could never load (RFC 0016 §7). The new functions are the policy layer: declaring `@guren/plugin-mcp` under `dependencies` is the opt-in, and the transport entry is then the one thing dropped from the stub set. The Dev MCP's `McpServer`, `@guren/cli`, `bun:sqlite` and `vite` stay stubbed for every app.

A minor rather than a patch: `internal/deploy-build` is a published subpath of `@guren/core`, so these are new exports on a shipped surface, and a caret range does not deliver an export the installed package does not have. `DEV_ONLY_MODULES` itself is unchanged.
