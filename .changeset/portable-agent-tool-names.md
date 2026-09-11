---
"@guren/server": minor
"@guren/plugin-mcp": minor
"@guren/cli": minor
---

Rename the meta-tools to `guren_preflight` / `guren_approval_status`, and warn on a tool name some clients drop

Claude Managed Agents restricts MCP tool names to `[a-zA-Z0-9_-]` and silently
skips every tool outside it: the server answers `tools/list` correctly, the
client discards the entries, and the agent runs with an empty catalogue while
the app's own logs show nothing (#787). Guren derives a tool name from the
route name verbatim, and route names conventionally carry dots, so an
idiomatically named app hit this on every tool. Routes already had an escape
hatch, `agent: { toolName: 'posts_index' }`. The framework's own meta-tool
`guren.preflight` had none.

- `PREFLIGHT_TOOL_NAME` is now `guren_preflight` and `APPROVAL_STATUS_TOOL_NAME`
  is `guren_approval_status`. An MCP client that hard-coded the dotted spelling
  must switch; code reading the constants is unchanged. Audit records written
  from now on carry the new names (a rehearsal, whether over MCP or
  `guren tool:call --preflight`, is recorded as `guren_preflight`), and the
  approval gate's `pollWith` answers the new name.
- `PORTABLE_AGENT_TOOL_NAME_PATTERN` (`^[A-Za-z0-9_-]{1,64}$`) is exported
  beside `AGENT_TOOL_NAME_PATTERN`: the grammar the Claude and OpenAI tool APIs
  enforce, a strict subset of MCP's. The reserved names are pinned to it.
- `guren check` gains `agent-route-portable-name:*`, a **warn** on a tool name
  that is legal MCP but falls outside the portable grammar, proposing the
  `toolName` spelling (`posts.index` → `posts_index`). A warn rather than a
  fail: the name is legal, and an app whose clients accept dots has nothing to
  fix. The derivation itself is unchanged, since a dot-to-underscore default
  would rename every existing tool, token scope and audit record.
