---
'@guren/cli': minor
---

`change:lane` and `change:evidence` take `--base-record <file>` (RFC 0040 §3): where the merge base cannot be rebuilt from the install on disk (its lockfile is not the one installed), the `record.json` an earlier `change:evidence` run wrote for the merge base stands in, and its security records are compared with the head's, read alone. A stored record of another commit, record format, deploy target or `NODE_ENV` is not compared and stays not judged at `medium`, naming the run to repeat; one written by another `@guren/cli` or `@guren/server` is compared and its versions are named beside the result. With the audit on, `record.json` now carries the head's records whatever the change touched.

The workflow `guren add review` writes gains `actions: read` and a step that downloads the record a push run on the default branch stored for the merge base and passes it. It reads no other run's record, since a pull request writes those, so a pull request stacked on another branch has none. An app that already has `.github/workflows/change.yml` keeps its copy: run `bunx guren add review --force` or add the `Base record` step and the `actions: read` permission by hand.
