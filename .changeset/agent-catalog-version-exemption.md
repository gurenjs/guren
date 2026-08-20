---
"@guren/cli": patch
---

Exempt the agent-catalog changeset gate on a moved `@guren/cli` version rather than on a manifest-only diff. A push or squash carrying both a catalog change with its changeset and the `changeset version` commit that consumes it no longer fails the gate, and a manifest edit that leaves the version alone is now gated rather than waved through.
