---
'@guren/server': patch
---

Name `guren_make_feature` in the MCP tool's API-only refusal

The `guren_make_feature` MCP tool delegates to the CLI's `makeFeature`, whose
API-only-app refusal names the command that was invoked. The MCP server now
passes its own tool name through, so an agent reads a refusal about the tool it
actually called rather than about `guren make:feature`.
