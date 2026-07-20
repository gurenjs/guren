---
'@guren/cli': minor
---

Add a `plugin-authoring` skill to the AI agent harness (`bunx guren agent:init` / `agent:sync`). Covers both installing an existing Guren plugin (`bunx guren plugin <pkg>`, including the manifest-driven provider/env/publishes flow and the no-`provider` manual-registration case) and authoring a new plugin package (`definePlugin()`, the `gurenPlugin` manifest fields, contributing CLI commands, and testing with `@guren/testing`).
