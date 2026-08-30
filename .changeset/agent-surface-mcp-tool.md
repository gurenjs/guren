---
"@guren/server": minor
---

Add a `guren_agent_surface` tool to the development MCP endpoint (RFC 0016 §9).

Reports every route that declares agent metadata — tool name, method and path, description, exposed surfaces, MCP annotations as declared, approval requirement, and derivable authorization — so a coding agent can see whether the route it is about to edit is already reachable by an autonomous agent. Reads the project context the CLI produces, so it inherits the same fresh-process route loading the other route-dependent tools use; annotation defaults are deliberately not filled in here, since the derivation layer owns that rule.

It stays a separate tool rather than a field on `guren_get_context` for the reason the agent-interface guidance itself gives: a catalog an agent must read in full is a catalog that costs context, and the exposure question is asked about one route at a time, usually right before editing it. `guren_get_context` answers "what is in this project" for a whole session; this answers "what can an autonomous agent already invoke" in a payload small enough to ask casually. When the app's `@guren/cli` predates agent metadata, the tool says so explicitly instead of returning an empty list — "nothing exposed" and "this CLI cannot answer" are different facts.
