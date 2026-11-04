---
'@guren/cli': minor
---

`guren audit` and `guren deps:exposure` end with "What these results rest on without checking" (RFC 0039 §9): the source of Bun's own advisories and any version that names no exact release, the packages only `@guren` packages bring in, each reader that stopped short in the run, the response values the column rule could not follow, each fix left as `candidate`, and the lockfile's integrity hashes, which Bun checks at install. The section is built from what the run read, so a check it skipped is said to be missing. `--json` carries the entries under `trustBoundary` in both reports, and the `guren_get_dependency_exposure` MCP tool returns them with the document.
