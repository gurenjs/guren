---
'@guren/plugin-mcp': minor
---

Every `dev.guren/response` now carries `contract`, the version of the MCP Apps result keys and the bridge catalogue, and `bridge`, the catalogue's URI, so a view built for another version can tell and hand its visits to the browser. A page URI whose `?v=` names an earlier build now answers the current build instead of not-found: Claude keeps the URIs of the `tools/list` it already has after a redeploy, and refusing them left every view as plain text until the connector was reconnected. A URI with any other query, a fragment, or a page the caller cannot see is still not found.
