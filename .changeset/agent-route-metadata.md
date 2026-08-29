---
"@guren/server": minor
---

Add agent exposure metadata to routes (RFC 0016 Phase 1).

- `RouteBuilder.agent(metadata)` and the `agent` key on `RouteContractOptions` mark a route as an agent tool. The metadata (`AgentRouteMetadata`: description, toolName, expose, MCP annotation hint overrides, approval, redact) is storage-only — input/output schemas, authorization, and annotation defaults derive from the contracts the route already carries.
- `resource()` accepts per-action metadata via `ResourceRouteOptions.agent`; an action not listed is not exposed (deny by default), and metadata for an action the call does not register (excluded via `only`/`except`, or missing from the controller) throws.
- `RouteDefinition.agent` carries the declared metadata through `definitions()`. Metadata is snapshotted on attach and on read, so neither side can mutate the router's copy.
