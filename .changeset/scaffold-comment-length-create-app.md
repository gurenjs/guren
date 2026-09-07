---
'create-guren-app': patch
---

Split the over-long comment blocks in the default, api-only, blog, and SQLite templates so a freshly scaffolded app's first `bun run lint` reports no `guren/comment-length` warnings on framework-generated files.
