---
"@guren/cli": patch
---

Report a routes file `guren context <Entity>` could not read, instead of reporting that the entity has no routes.

The entity bundle loads the routes file for real — it imports it to read the definitions off a router — and caught every failure of that import as an empty result. An app whose routes could not be loaded therefore rendered exactly what an app whose entity has no routes renders: `## Routes (0)` and `No routes reference this entity.`, exit 0. Every reader of that bundle, agent or human, had no way to tell a confident answer from a failed one. The reason is now printed in place of that line, with the note that the list is incomplete.
