---
'@guren/plugin-agents': patch
---

An agent's principal is now built from the name its Durable Object was addressed by, the one the route authorizer approved, rather than from the SDK's decoded `Agent.name`. A root object routed by a name the SDK decodes as `cf-agents:v2:…` could otherwise act as another instance's principal.
