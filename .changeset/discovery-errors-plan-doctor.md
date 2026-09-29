---
"@guren/cli": patch
---

Stop reading an unreadable directory as an empty one in `plan:status`, `plan:verify` and `doctor --next`. A side-effect directory that will not open now leaves a planned job, event, listener, mail or notification `blocked` with the directory named, where an added one read as absent and a dropped one as done; the plan detail for policies and resources carries the same reason instead of an empty list. `plan:verify` records a `tests` or `tests:fail` step `blocked` when the test files cannot be listed, instead of `failed` for carrying no test. `doctor --next` adds one step naming the unreadable directory in place of the suggestions its scan would have made, and no longer reports that the project has no test infrastructure.
