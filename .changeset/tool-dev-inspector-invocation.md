---
"@guren/cli": patch
---

Print an MCP Inspector invocation `tool:dev` users can actually run

The command printed `npx @modelcontextprotocol/inspector --cli <endpoint> --transport http --header "Authorization: Bearer <token>"`, which exits on `Method is required` because `--cli` mode has no default method. It now prints `--method tools/list`, pins the spec with `@latest` so the resolution does not fall to whatever version the npx cache already holds, shows the `tools/call` tail, and mentions that dropping `--cli` opens the browser Inspector UI.
