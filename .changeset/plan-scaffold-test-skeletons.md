---
'@guren/cli': minor
---

`guren plan:scaffold` writes a plan's `tests` step: `tests/plans/<plan>/<collection>.test.ts` with one `TestApp` test per acceptance behaviour, titled `[<id>] <description>`, making the request its route names and asserting the status, redirect, Inertia page, validation errors and database rows the plan expects. The setup the plan states in prose, the signed-in actor and each path parameter are `given()` calls that throw, and an expectation it cannot write is an `unwritten()` call, so every test fails until it is written and none is skipped, which is what `plan:verify` needs from the step. `plan:next` names the command for the step, and the `plan-implement` skill describes it; an existing app picks the skill up with `bunx guren agent:sync`.
