---
"@guren/server": minor
---

Add a `guren_agent_surface` tool to the development MCP endpoint (RFC 0016 §9).

Reports every route that declares agent metadata — tool name, method and path, description, exposed surfaces, MCP annotations as declared, approval requirement, and derivable authorization — so a coding agent can see whether the route it is about to edit is already reachable by an autonomous agent. Reads the project context the CLI produces, so it inherits the same fresh-process route loading the other route-dependent tools use; annotation defaults are deliberately not filled in here, since the derivation layer owns that rule.
