---
"@guren/cli": patch
"@guren/server": patch
---

The docs viewer's page is written in TypeScript under `src/docs-viewer-page/` and bundled into the shipped HTML at build time, the way the plan page is, so the page is type-checked against the payload it reads. `docsViewerShell()` returns the page (composed from source when the CLI runs from source), and the server reads it when the CLI provides it. The zoom buttons move to the bottom right, clear of the published snapshot's banner.
