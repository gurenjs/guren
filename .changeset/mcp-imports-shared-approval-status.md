---
'@guren/plugin-mcp': patch
---

Read the approval-status rule from `@guren/core` instead of restating it

`guren.approval_status` keeps its MCP schema, description and audit statuses;
what it no longer owns is how a stored record becomes an answer. That rule now
lives in the framework and is shared with the durable agent surface, so a record
this tool reports as approved cannot be one another surface hides.
