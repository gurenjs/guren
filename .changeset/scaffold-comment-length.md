---
'@guren/cli': patch
---

Split the over-long comment blocks in the scaffold and agent-harness templates so a freshly scaffolded app's first `bun run lint` reports no `guren/comment-length` warnings on framework-generated files. Each block is split by fact and placed on the code it describes; no guidance is dropped.
