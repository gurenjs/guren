---
'@guren/server': minor
---

fix: make the `guren_codegen` MCP tool regenerate changed artifacts

The tool called the CLI generators without `force`, so as soon as a route
changed — the one case where regeneration matters — the writer refused with
"already exists. Use --force to overwrite." A blanket `catch {}` per generator
swallowed that, and the tool reported `{"generated": []}` as a success. It now
passes `force: true`, the way `guren codegen` already does, since these
outputs are generated artifacts that exist to be overwritten.

Skips are no longer silent. The response carries a `skipped` array naming each
artifact and the reason it was not produced, and a generator that throws now
marks the whole run as an error even when other artifacts were written. A
generator that simply found nothing to describe — an app with no page
components, for instance — is reported as a skip rather than a failure.

The tool also generates `.guren/api-client.gen.ts`, which it previously left
out even though `guren codegen` produces it. Because the API client is built
from the route manifest, an agent that added a route through MCP got every
other artifact refreshed while the client silently went stale.
