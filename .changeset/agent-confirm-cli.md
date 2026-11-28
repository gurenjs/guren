---
'@guren/cli': minor
'@guren/testing': minor
'@guren/server': minor
'@guren/core': minor
---

The surfaces that dispatch an agent tool without the invocation pipeline now honour `confirm` (RFC 0042 §2.5).

- `guren tool:call` asks before it runs a `confirm` tool: in a terminal it shows the route's message and the arguments as the audit trail would record them, and anywhere nobody can be asked (a script, CI, `--json`) the call is refused unless `--confirm` is passed. `--preflight` never asks.
- `app.agent().call()` in `@guren/testing` throws for a `confirm` tool unless the test passes `{ confirm: true }`, so a test no longer shows a call succeeding that every agent surface would ask about or refuse. A rehearsal (`{ preflight: true }`) is unaffected.
- `.guren/agents.gen.ts` carries `confirm` for a tool that declares it.
- `guren check` warns (`agent-route-confirm-webmcp`, advisory) on a route that declares `confirm` and `expose: { webMcp: true }`: the tool is kept off WebMCP either way.
- `tool:list` shows `confirm` among a tool's flags, and `tool:inspect` on a `Confirm:` line.
- The agent harness's `agent-interface` skill documents the field. Run `bunx guren agent:sync` to refresh an installed harness.

`@guren/server` exports `readAgentConfirm()`, the one reading of the field that the derivation, the router and `guren check` share.
