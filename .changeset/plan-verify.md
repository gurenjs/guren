---
"@guren/cli": minor
---

Add `guren plan:verify <plan> [--step <id>] [--app <dir>] [--timeout <s>] [--ci] [--json]`
(RFC 0030 §6), the executing half of plan status. For one derived step, or every
step in task order, it runs the step's verify commands (`codegen`, `typecheck`,
`db:migrate`, `guren check`, and the tests) and records the result under
`.guren/plans/<slug>.state.json`, which it git-ignores through a `.gitignore`
written beside it: a verification is a fact about one environment, and a fresh
clone sees every element as at most `wired` until it has run there.

Every step's verify list now opens with `codegen`, so a step verified on its own
does not fail on a fresh clone's missing `.guren/*.gen.ts`. Tests are `bun test
--reporter=junit` on the files whose source carries the step's acceptance ids,
selected by file and never by `-t`; `tests` passes when every behaviour passes and
the run exits 0, `tests:fail` when every behaviour has a case and each case
failed. What cannot run here is `blocked`, never a failed implementation: a script
`package.json` lacks, a tool the shell cannot find, a command that timed out, a
migration whose output names an unreachable database, a check that threw. A step
is `verified` when every command passed and every element it owns is at the state
its kind completes at (`wired` where it has a mount point, `present` otherwise and
for a `drop`, or `unjudged`); one with a passing run and an element still
`planned` is `incomplete`, listing them.

Each record carries a fingerprint: the SHA-256 of every file the readers found
the step's elements in, plus the test files, and the environment it ran in.
`plan:status` now lays the records over its result: an element of a verified step
is `verified` while every fingerprinted file still hashes the same and `drifted`
once one does not, naming the file; an element none of whose files the record
covers is not lifted, since that result could never expire, and a record from
another plan or revision is reported as stale and lifts nothing. For that, every
element in the status report carries `files` and `completesAt`, and the summary
counts all eight states.
