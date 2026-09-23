---
"@guren/cli": patch
---

`guren plan:verify --step <id>` re-runs, before the step, every earlier step whose verified record a later step's edit to a shared file (a routes file, the schema, a controller) left drifted, and records it verified again or failed with what broke; the Stop hook does this on every stop that verifies the marked step, without spending a continuation. `plan:next` tells a drifted step to be re-checked with `plan:verify --step` rather than re-implemented. A data step's `db:migrate` now first asks the application's own drizzle-kit (`generate --explain`) whether the migrations cover the schema: uncovered changes fail the step, and a drizzle-kit that cannot answer blocks it.
