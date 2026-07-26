---
"@guren/cli": patch
---

fix: `guren check` and `doctor --next` no longer claim a controller is untested when it is only named differently

Controller-test detection matches filenames — `<Name>Controller.test.ts` beside
the controller or under `tests/`, the layouts `make:test` scaffolds. It reported
a miss as `No test file found for TaskController.`, an assertion about coverage
that the check cannot make.

An app that groups tests by feature hits this on every controller. Worse,
`doctor --next` promoted each miss to a numbered next step with a `make:test`
command — on a real app that was 10 of 21 steps, every one of them proposing to
duplicate coverage that already existed.

Detection is unchanged; what it says about itself is not. `guren check` now names
the miss as a naming one, lists the paths it probed, and states that detection is
by filename only. `doctor --next` retitles the step from `Add tests for X` to
`Confirm test coverage for X`, and both the check's suggestion and the step's
description ask for that confirmation first — the structured `title`, `command`,
and `suggestion` fields are what agents and the MCP surface act on, so cautious
prose alone would not have changed the outcome.

Detection was left alone deliberately. The documented way to test a controller is
to boot the app and drive its routes through `TestApp`, and such a test
references neither the controller class nor its file — so no amount of parsing
the test would find the link, and guessing from filename shape (`tasks.test.ts`
→ `TaskController`) would silence real gaps to hide this one. The bound is now
recorded on `controllerTestCandidates` so callers keep phrasing results as
"no test named after this controller". Note the same bound in the other
direction: a `TaskController.test.ts` that never mentions the class still counts,
because only the filename is ever examined.

`guren context <Entity>` has its own filename matcher with the same blind spot;
that one is untouched here.
