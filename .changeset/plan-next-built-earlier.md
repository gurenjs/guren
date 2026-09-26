---
"@guren/cli": patch
---

`plan:next` no longer names `plan:scaffold` for a `scaffold` or `tests` step whose targets are already on disk, which `plan:scaffold` refuses. It reports the step as scaffolded (`scaffolded` in `--json`, in place of `scaffold`), lists what is still missing to write by hand, names the earlier plan hash when the step was built under an earlier version of the plan (after a revision), and points to `plan:verify --step`. The files are the ones the plan names, so nothing of the application is read for it.
