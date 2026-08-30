---
'@guren/cli': minor
---

Add `guren tool:dev`, which serves this application's agent tools locally with a throwaway bearer token and prints the MCP Inspector invocation that connects to it (RFC 0016 §6).

The endpoint is the application's own — the command mounts nothing and inspects nothing. What it adds is the one thing that makes the real endpoint awkward to try: a token, without asking anyone to mint a lasting credential to look at a catalogue.

The token is ephemeral by construction rather than by policy. It is issued into a `MemoryApiTokenStore` the command creates and then installs over whatever store the app configured, so nothing is written to the app's real store and nothing survives the process — "revoking" it is exiting. The override works because `@guren/plugin-mcp` resolves the store per request rather than at boot.

Before printing anything the command asks the running app whether the endpoint is really there: a mounted one answers 401 without a bearer, an app that never registered the plugin answers 404, so a missing `mcpPlugin()` is named as such instead of surfacing later as a confusing client error. `--path` covers a plugin mounted elsewhere, `--as <id>` picks the user tool calls authenticate as (the default is a placeholder matching no record, so listing works and a call whose policy loads a user fails visibly), and the command refuses to run with `NODE_ENV=production`.
