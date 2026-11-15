---
'@guren/cli': minor
---

`guren change:policy` now reads the application without its env files: the introspection child runs with `--no-env-file` and without every value the app's env files (or the start directory's) give a name, under any `NODE_ENV`, so the `REVIEW.md` block reads the same on a machine with a git-ignored `.env` and in CI. `guren change:evidence` runs `change:policy --check` where `REVIEW.md` exists and holds the change (`review-doc-stale`, `review-doc-unchecked`) while the block is stale or the check cannot read the application, without failing the workflow.
