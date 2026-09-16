---
'@guren/core': patch
---

`DEV_ONLY_MODULES` records that no package imports the v1 MCP transport any more (`importedBy: null`) now that `@guren/plugin-mcp` runs on SDK v2. The entry stays, so the stub file a committed `wrangler.jsonc` aliases keeps being written; deploy output is unchanged.
