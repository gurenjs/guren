---
"@guren/cli": patch
---

`guren plan:verify --step <id>`, once the step verifies, re-checks every earlier step whose verified record an edit to a shared file (a routes file, the schema, a controller) left drifted, and records it verified again or failed with what broke; a step that does not verify, or a re-check that is blocked, leaves the drifted record for a later run, and a drifted `tests:fail` step is re-checked without a run, staying verified while a test file still carries each behaviour's id; the Stop hook does this on every stop that verifies the marked step, without spending a continuation. `plan:next` tells a drifted step to be re-checked with `plan:verify --step` rather than re-implemented. A data step's `db:migrate` now first asks the application's own drizzle-kit (`generate --explain`) whether the migrations cover the schema: uncovered changes fail the step, and a drizzle-kit that cannot answer blocks it.
