---
"@guren/cli": minor
---

Add `guren plan:status <plan> [--app <dir>] [--json]` (RFC 0030 §6), the static
half of plan status. It compares an implementation plan with the code and reports
one state per element (`planned`, `present`, `wired`, `drifted`, `unjudged`,
`blocked`) with a `match` / `differ` / `unknown` verdict per planned property.
Like `check` and `doctor` it imports the routes file, and it reads `db/schema.ts`
through the runtime reader with the static reader as fallback; it boots nothing,
runs no test and needs no database.

A property no reader can see is `unknown`: it never counts towards `present`,
never satisfies a `drop`, and is listed per element as "planned, not checkable".
`wired` needs evidence that the application mounts what the CLI loaded, read from
`createApp({ routes, modules })` in the app entry; without it the element stays
`present` with the reason. For a validator the evidence must be a use rather than
a mention — `this.validateBody/Query/Params(` in a mounted action, or a mounted
route whose *registered* contract schema is the exported symbol itself, matched by
object identity — since an identifier can be named by a leftover import, in a type
position, in an object nobody passes or in a branch nothing reaches. A planned
`body` / `params` / `query` validator on an action is read the same way, so an
action whose only planned property is a validator its body merely mentions is
`unjudged` rather than `wired`. An element's optional `module` is compared in both directions, so
a same-named element in another app root neither satisfies it nor is satisfied by
it. The command exits 0 for any computed status and non-zero only when the plan
cannot be read or does not match the schema.

`judgePlan()` in `src/plan/status.ts` is the pure judge; `verified` and `waived`
are part of its state type and are left for `plan:verify` and `plan:waive`.
