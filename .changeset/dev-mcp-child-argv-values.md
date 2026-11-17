---
'@guren/cli': patch
---

The Dev MCP's `guren_entity_context` tool and its `guren://context/{entity}` resource pass the values a request carries to the child `guren context` process as `--entity=<value>`, `--module=<value>` and `--repo=<value>`. A value starting with `-` (`--routes=/tmp/x.ts`, `--app=/tmp/dir`) was parsed as a flag of its own, so a caller reaching the endpoint could make the child CLI import a file or introspect a directory outside the project. Such a value is now looked up as the entity or module it names, and fails as one that does not exist.
