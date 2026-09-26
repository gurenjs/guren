---
"@guren/cli": patch
---

Typecheck a plan's `http` step. `plan:verify` now runs `codegen`, `typecheck`, `guren check` and then the tests on a task's last `http` step, so a controller that calls a model method with the wrong arguments no longer verifies while its behaviours pass. Earlier parts of a split `http` step do not typecheck, since one may import what a later part writes. `plan:next` lists the added pages an `http` step's actions render (`pageStubs`), to be created there as stubs so `.guren/pages.gen.ts` names them. An app with no `typecheck` script now has that step blocked, as its `data` and `pages` steps already were. The tests run only on the step the behaviours are judged at: an `http` step with no acceptance behaviours (an earlier part of a split step, or a task with none) no longer lists a `tests` command, which printed `pass tests bun test` without running anything.
