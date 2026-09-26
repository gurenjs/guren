---
'@guren/cli': minor
---

`guren plan:verify` now checks that each acceptance behaviour's test still requests the route the behaviour names (RFC 0030 §5). Before it runs `bun test` for a `tests` or `tests:fail` command, it reads the selected test files: some `test`, `it` or `describe` whose title carries the behaviour's id must make a `TestApp` request to the planned route's method and path, or call its agent tool, in its own body or in a function of the same file it calls. A test that requests another route, or nothing, fails the command and names what it requests instead, without running the tests. A request the reading cannot resolve (a path the file does not spell, a request on what an imported helper returns, a `TestApp` handed to a function from another file) fails it too, with its own reason, since a test rewritten that way would otherwise verify the step. The re-check of a drifted `tests` step, which runs nothing, applies the same rule.

Tests written for a plan before this release may need their request moved into the test case, or out of a shared helper file, before `plan:verify` passes them. `plan:next` states the rule under a `tests` step's behaviours, and the harness `plan-implement` skill repeats it (`bunx guren agent:sync` to refresh it).

A path segment filled whole at runtime (`` `/comments/${id}` ``) counts as reaching a constrained parameter in this check, since whether the value passes the constraint is the test run's to find. A request on what a function of the same test file returns is read only when that function is annotated to return a `TestApp` or `Promise<TestApp>`; otherwise it is reported as unresolved, here and in the Impact section `plan:render` writes, with that annotation as the remedy.
