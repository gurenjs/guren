---
"@guren/cli": minor
---

Check, audit, and context support for agent-exposed routes (RFC 0016 Phase 1c).

- `guren check` gains agent-route rules, running in the normal suite for any app whose routes declare `.agent()` metadata (an app with none contributes nothing). Failures: a route with agent metadata and no name (the tool name is the tool's identity), a tool name outside the MCP grammar `^[A-Za-z0-9._-]{1,128}$`, two routes resolving to one tool name, and a non-read-only tool with neither an authorization capability on its middleware chain nor `this.authorize(...)` in the action — authentication is not authorization, so `this.auth.userOrFail()` alone still fails, with its own message. Warnings: a tool that advertises no output schema or resource hint, an action that answers with `this.inertia(...)`, and a body-carrying route with no `body` schema for the derived input schema to be built from.
- `guren audit` treats agent-exposed routes more strictly: a body-validation finding that is a warning for an ordinary route becomes a failure when the route is an agent tool (same finding key, so existing `config/audit.ts` entries keep applying). New `agent-annotation:` rule: `destructiveHint: false` declared on an action that deletes records warns.
- `guren context <Entity>` gains an `## Agent Interfaces` section describing each agent-declared route as the tool it becomes (name, description, input parts, output, authorization, annotations, approval). `ContextRoute` carries the declared `agent` metadata and a derived `authorization` field, which names an ability only when the middleware chain makes exactly one derivable.
- The coding-agent harness gains an `agent-interface` skill, plus `.agent()` coverage in the routing rule file and the API digest.
