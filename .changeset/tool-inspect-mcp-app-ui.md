---
'@guren/cli': minor
---

`guren tool:list` and `guren tool:inspect` show a route's MCP Apps declaration (`.agent({ ui })`). The table gains a `UI` column with the page an MCP Apps host renders, marked `app only` for a tool the model never sees. `tool:inspect` prints a `UI:` line with the page and the audiences, and its Output section names the page the result renders as instead of reporting no output schema.
