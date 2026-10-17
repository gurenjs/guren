---
"create-guren-app": patch
---

The scaffolded app's CI workflow uses `actions/checkout@v7`, which runs on Node.js 24; `@v4` ran on Node.js 20, which GitHub Actions has deprecated and now warns about on every run.
