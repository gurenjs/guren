---
'@guren/cli': minor
---

`guren audit` now shows, under each dependency advisory, the installed versions inside its affected ranges and the routes that reach each one, read from the `guren deps:exposure` document (RFC 0039 §5). Advisories `bun audit` lists once per range are kept as one finding with every range (`advisory.ranges`), and the finding keys are unchanged. `--deps-baseline <file>` is for a scheduled run: it exits 1 on an advisory a previous `guren audit --json` report (or an array of keys) does not name, and on a dependency scan that did not complete. The dev MCP server gains `guren_get_dependency_exposure`, which takes an optional `package`.
