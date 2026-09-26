---
"@guren/cli": patch
---

`plan:next` no longer tells you to run `plan:scaffold` for a step that was already scaffolded under an earlier revision of the plan. When a `scaffold` or `tests` step's record names an earlier plan hash and the files `plan:scaffold` would write are already on disk, `plan:next` reports the step as built under an earlier revision (`builtEarlier` in `--json`) and points only to `plan:verify --step`. It no longer names the `plan:scaffold` command, which would refuse those files.
