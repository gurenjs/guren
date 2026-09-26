---
"@guren/cli": patch
---

Typecheck a plan's `http` step. `plan:verify` now runs `codegen`, `typecheck`, `guren check` and then the tests on an `http` step, so a controller that calls a model method with the wrong arguments no longer verifies while its behaviours pass. The tests run only on the step the behaviours are judged at: an `http` step with no acceptance behaviours (an earlier part of a split step, or a task with none) no longer lists a `tests` command, which printed `pass tests bun test` without running anything.
